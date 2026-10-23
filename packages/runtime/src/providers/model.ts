// What a provider adapter hands the execution layer for one invocation of a run.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage } from '@langchain/core/messages';
import type { AgentMiddleware } from 'langchain';
import type { ModelCallReports } from '../execution/failures.ts';

export interface WiredModel {
  model: BaseChatModel;
  /** For the model boundary: ends the call's screening leases. */
  modelCallSettled: () => void;
  /** For the model boundary: the call's classified unsuccessful responses. */
  reports: ModelCallReports;
  /**
   * For the model boundary: checks a parsed response before anything in it is stored or acted on. Returns a refusal
   * reason (a short code) when the response is not a complete, successful one.
   */
  responseRefusal?: (message: AIMessage) => string | undefined;
  /**
   * Inside the model boundary: the provider's tool-name translation (./tool-names.ts), so the model sees names its
   * wire contract accepts while everything the boundary sees and stores keeps the canonical names.
   */
  toolNames: AgentMiddleware;
}
