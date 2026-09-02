// Raw-table observation of the Store schema.
//
// Namespace paths are projected BOTH as the stored `:`-joined text and as the
// round-tripped array, because a delimiter collision is only visible as a
// mismatch between the two. Joining before comparison would make `["a:b"]` and
// `["a","b"]` indistinguishable, which is the defect under test.

import type { Db } from "../db.ts";
import { STORE_SCHEMA } from "../contract.ts";

export type StoreItemRow = {
  namespace_path: string;
  key: string;
  value_text: string;
  value_digest: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  expired: boolean;
  bytes: number;
};

export type StoreVectorRow = {
  namespace_path: string;
  key: string;
  field_path: string;
  text_content: string;
  dims: number;
  embedding: string;
};

export type StoreProjection = {
  items: StoreItemRow[];
  vectors: StoreVectorRow[];
  migrations: number[];
  /** Items with no vector row: invisible to vector and hybrid search. */
  unindexedItems: Array<{ namespace_path: string; key: string }>;
  /** Vector rows whose text_content no longer matches the item's value. */
  staleVectors: Array<{ namespace_path: string; key: string; field_path: string }>;
  stats: {
    total: number;
    live: number;
    expired: number;
    namespaces: number;
  };
};

async function tableExists(db: Db, table: string, schema = STORE_SCHEMA): Promise<boolean> {
  const { rows } = await db.pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`${schema}.${table}`],
  );
  return rows[0]?.present ?? false;
}

/**
 * `schema` is a parameter because schema isolation is one of the things under
 * test: d11 runs two Stores in two schemas of one database, and comparing them
 * requires projecting each with the same code rather than trusting either API.
 */
export async function projectStore(
  db: Db,
  prefix: string | null = null,
  schema = STORE_SCHEMA,
): Promise<StoreProjection> {
  const empty: StoreProjection = {
    items: [],
    vectors: [],
    migrations: [],
    unindexedItems: [],
    staleVectors: [],
    stats: { total: 0, live: 0, expired: 0, namespaces: 0 },
  };

  if (!(await tableExists(db, "store", schema))) return empty;

  const like = prefix === null ? "%" : `${prefix}%`;

  const items = await db.pool.query<StoreItemRow>(
    `SELECT namespace_path, key,
            value::text                            AS value_text,
            md5(value::text)                       AS value_digest,
            created_at::text                       AS created_at,
            updated_at::text                       AS updated_at,
            expires_at::text                       AS expires_at,
            (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS expired,
            pg_column_size(value)                  AS bytes
       FROM ${schema}.store
      WHERE namespace_path LIKE $1
      ORDER BY namespace_path, key`,
    [like],
  );

  const migrations = await db.pool
    .query<{ v: number }>(`SELECT v FROM ${schema}.store_migrations ORDER BY v`)
    .then((result) => result.rows.map((row) => row.v))
    .catch((error: { code?: string }) => {
      if (error.code === "42P01") return [];
      throw error;
    });

  let vectors: StoreVectorRow[] = [];
  let unindexed: Array<{ namespace_path: string; key: string }> = [];
  let stale: Array<{ namespace_path: string; key: string; field_path: string }> = [];

  if (await tableExists(db, "store_vectors", schema)) {
    const result = await db.pool.query<StoreVectorRow>(
      `SELECT namespace_path, key, field_path, text_content,
              vector_dims(embedding) AS dims,
              embedding::text        AS embedding
         FROM ${schema}.store_vectors
        WHERE namespace_path LIKE $1
        ORDER BY namespace_path, key, field_path`,
      [like],
    );
    vectors = result.rows;

    const missing = await db.pool.query<{ namespace_path: string; key: string }>(
      `SELECT s.namespace_path, s.key
         FROM ${schema}.store s
         LEFT JOIN ${schema}.store_vectors v
                ON v.namespace_path = s.namespace_path AND v.key = s.key
        WHERE s.namespace_path LIKE $1 AND v.key IS NULL
        ORDER BY 1, 2`,
      [like],
    );
    unindexed = missing.rows;

    // The independent staleness oracle: the embedded text is compared to the
    // item's current value, not to whatever the Store believes it indexed.
    const drifted = await db.pool.query<{
      namespace_path: string;
      key: string;
      field_path: string;
    }>(
      `SELECT v.namespace_path, v.key, v.field_path
         FROM ${schema}.store_vectors v
         JOIN ${schema}.store s
           ON s.namespace_path = v.namespace_path AND s.key = v.key
        WHERE v.namespace_path LIKE $1
          AND position(v.text_content in s.value::text) = 0
        ORDER BY 1, 2, 3`,
      [like],
    );
    stale = drifted.rows;
  }

  const total = items.rows.length;
  const expired = items.rows.filter((row) => row.expired).length;

  return {
    items: items.rows,
    vectors,
    migrations,
    unindexedItems: unindexed,
    staleVectors: stale,
    stats: {
      total,
      live: total - expired,
      expired,
      namespaces: new Set(items.rows.map((row) => row.namespace_path)).size,
    },
  };
}

/** The stored text and the round-tripped array, so a `:` collision is visible. */
export function namespaceRoundTrip(stored: string): { stored: string; roundTripped: string[] } {
  return { stored, roundTripped: stored.split(":") };
}

export type StoreConflictWitness = {
  itemRows: number;
  /** Which candidate marker the surviving value carries, or `unknown`. */
  itemOwner: string;
  vectorRows: number;
  /** Which candidate the surviving embedded text belongs to, per vector row. */
  vectorOwners: string[];
  /**
   * The Store form of the b06 question. `null` when there is no single owner on
   * one side, because "they disagree" and "there is nothing to compare" are
   * different results and must not share a value.
   */
  itemOwnerEqualsVectorOwner: boolean | null;
  /** A vector row whose item is gone. The FK forbids it, so a non-zero count is a fault. */
  orphanVectors: number;
};

/**
 * Attributes the surviving Store row and its vectors to the candidate that
 * wrote them.
 *
 * Both sides are matched against literal candidate strings rather than against
 * each other: "the value is party 1's and the vectors are party 0's" is the
 * finding, and it is only expressible if each side is identified independently.
 * A side matching no candidate is `unknown`, which is a torn value and a fault
 * rather than a race outcome.
 */
export async function storeConflictWitness(
  db: Db,
  namespacePath: string,
  key: string,
  markerByOwner: Record<string, string>,
  vectorTextByOwner: Record<string, string>,
): Promise<StoreConflictWitness> {
  if (!(await tableExists(db, "store"))) {
    return {
      itemRows: 0,
      itemOwner: "absent",
      vectorRows: 0,
      vectorOwners: [],
      itemOwnerEqualsVectorOwner: null,
      orphanVectors: 0,
    };
  }

  const items = await db.pool.query<{ value_text: string }>(
    `SELECT value::text AS value_text
       FROM ${STORE_SCHEMA}.store
      WHERE namespace_path = $1 AND key = $2`,
    [namespacePath, key],
  );

  const ownerOf = (haystack: string, table: Record<string, string>): string => {
    const hits = Object.entries(table).filter(([, needle]) => haystack.includes(needle));
    return hits.length === 1 ? hits[0]![0] : "unknown";
  };

  const itemOwner =
    items.rows.length === 1 ? ownerOf(items.rows[0]!.value_text, markerByOwner) : "absent";

  let vectorOwners: string[] = [];
  let vectorRows = 0;
  let orphanVectors = 0;

  if (await tableExists(db, "store_vectors")) {
    const vectors = await db.pool.query<{ text_content: string }>(
      `SELECT text_content
         FROM ${STORE_SCHEMA}.store_vectors
        WHERE namespace_path = $1 AND key = $2
        ORDER BY field_path`,
      [namespacePath, key],
    );
    vectorRows = vectors.rows.length;
    vectorOwners = vectors.rows.map((row) => ownerOf(row.text_content, vectorTextByOwner));

    const orphans = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ${STORE_SCHEMA}.store_vectors v
         LEFT JOIN ${STORE_SCHEMA}.store s
                ON s.namespace_path = v.namespace_path AND s.key = v.key
        WHERE s.key IS NULL`,
    );
    orphanVectors = Number(orphans.rows[0]?.count ?? "0");
  }

  const distinctVectorOwners = [...new Set(vectorOwners)];
  return {
    itemRows: items.rows.length,
    itemOwner,
    vectorRows,
    vectorOwners,
    itemOwnerEqualsVectorOwner:
      distinctVectorOwners.length === 1 && itemOwner !== "absent" && itemOwner !== "unknown"
        ? itemOwner === distinctVectorOwners[0]
        : null,
    orphanVectors,
  };
}

/**
 * Where `CREATE EXTENSION vector` actually put the extension, and how the store
 * schema's column type resolves to it.
 *
 * The migration says `embedding vector(N)` with no schema qualification, so the
 * type only resolves while the extension's schema is on the search_path. That
 * makes "the Store lives in its own schema" and "the Store is self-contained"
 * different claims, and this is what tells them apart.
 */
export async function extensionPlacement(
  db: Db,
): Promise<{
  extensions: Array<{ name: string; schema: string }>;
  vectorColumnType: string | null;
  vectorTypeSchema: string | null;
  searchPath: string | null;
}> {
  const installed = await db.pool.query<{ name: string; schema: string }>(
    `SELECT e.extname AS name, n.nspname AS schema
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY 1`,
  );

  const column = await db.pool.query<{ type: string; type_schema: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type,
            tn.nspname                          AS type_schema
       FROM pg_attribute a
       JOIN pg_class c      ON c.oid = a.attrelid
       JOIN pg_namespace n  ON n.oid = c.relnamespace
       JOIN pg_type t       ON t.oid = a.atttypid
       JOIN pg_namespace tn ON tn.oid = t.typnamespace
      WHERE n.nspname = $1 AND c.relname = 'store_vectors' AND a.attname = 'embedding'`,
    [STORE_SCHEMA],
  );

  const path = await db.pool.query<{ search_path: string }>(`SHOW search_path`);

  return {
    extensions: installed.rows,
    vectorColumnType: column.rows[0]?.type ?? null,
    vectorTypeSchema: column.rows[0]?.type_schema ?? null,
    searchPath: path.rows[0]?.search_path ?? null,
  };
}
