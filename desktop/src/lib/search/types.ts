/*
 * The search contract: what any engine returns and the console shows.
 *
 * Today's engine (engine.ts) runs in the UI over metadata already loaded:
 * words, a vocabulary of what people ask for, and the links between records.
 * The planned one (docs/graph-search.md) runs in Rust behind a `graph_search`
 * command, adds meaning (embeddings) and a reranker, and returns this same shape,
 * so the console does not change when it lands.
 */

export type NodeKind =
  | 'account'
  | 'group'
  | 'project'
  | 'service'
  | 'device'
  | 'step'
  | 'account-secret'
  | 'note'
  | 'project-secret'
  | 'file'

/** One record of the vault, as search shows it. Never a secret value. */
export interface SearchNode {
  /** `${kind}:${id}`, e.g. "account:12"; a group's id is its name. */
  id: string
  kind: NodeKind
  title: string
  subtitle: string
  /** Where opening it goes. */
  to: string
  /** The device kind or sign-in step kind, for its icon. */
  detail?: string
}

/** A hop on the way to a result: the record, and how it relates to the one before. */
export interface PathStep {
  node: SearchNode
  /** "uses account", "lives on"…; null for the first step. */
  via: string | null
}

export interface SearchHit {
  node: SearchNode
  /** 0 to 1, comparable within one response only. */
  score: number
  /** From the record the question named, to this one. Just [node] when it was named itself. */
  path: PathStep[]
  /** It is the kind of thing asked for ("device" → devices), or one of the best matches. */
  answer: boolean
}

/** How the question was read, shown above the results so a surprise can be explained. */
export interface Understood {
  /** What is being looked for, from words like "device", "passkey", "secrets". */
  wants: { label: string; words: string[] }[]
  /** Words that named records: "coolify" → the Coolify service and its account. */
  anchors: { words: string; nodes: SearchNode[] }[]
  /** Words nothing matched yet (meaning search will take these). */
  unmatched: string[]
}

export interface SearchResponse {
  query: string
  understood: Understood
  hits: SearchHit[]
}
