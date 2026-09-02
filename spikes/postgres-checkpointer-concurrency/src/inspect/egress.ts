// Network isolation, measured rather than asserted.
//
// A timeout is deliberately NOT treated as isolation: a slow-but-open network
// would then read as a pass. Only an explicit unreachable/refused errno counts,
// and DNS is probed separately because a network can block 443 while still
// resolving names.

export type Egress = {
  isolated: boolean;
  tcp: { reached: boolean; errno: string | null };
  dns: { resolved: boolean; errno: string | null };
};

export async function measureEgress(): Promise<Egress> {
  const { connect } = await import("node:net");
  const { Resolver } = await import("node:dns/promises");

  const tcp = await new Promise<{ reached: boolean; errno: string | null }>((resolve) => {
    const socket = connect({ host: "1.1.1.1", port: 443 });
    const done = (reached: boolean, errno: string | null) => {
      socket.destroy();
      resolve({ reached, errno });
    };
    socket.setTimeout(3_000, () => done(false, "ETIMEDOUT"));
    socket.once("connect", () => done(true, null));
    socket.once("error", (error) =>
      done(false, (error as NodeJS.ErrnoException).code ?? "EUNKNOWN"),
    );
  });

  const dns = await (async () => {
    const resolver = new Resolver({ timeout: 2_000, tries: 1 });
    try {
      const addresses = await resolver.resolve4("example.com");
      return { resolved: addresses.length > 0, errno: null };
    } catch (error) {
      return { resolved: false, errno: (error as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
    }
  })();

  const blocked = new Set(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "EAI_AGAIN"]);
  return {
    isolated: !tcp.reached && !dns.resolved && blocked.has(tcp.errno ?? ""),
    tcp,
    dns,
  };
}
