import { plain, words, type GraphNode, type VaultGraph } from './graph'
import type { NodeKind, PathStep, SearchHit, SearchNode, SearchResponse, Understood } from './types'

/*
 * Today's engine: no model, no index, a few milliseconds over a vault this size.
 *
 *   1. Read the question: drop filler words, pick out what is asked for
 *      ("device", "passkey", "secrets"), and keep the rest as names.
 *   2. Find the records each name points to (exact, prefix, then close spellings;
 *      two words may be one name: "auto transfert" → Autotransfert).
 *   3. Walk the links out from those records, a little weaker at each hop, and
 *      prefer what every name leads to: "coolify auto" means the Coolify that
 *      belongs to Autotransfert, not any Coolify.
 *   4. Rank: the kind asked for first, then by how strongly it was reached; keep
 *      the path that explains each result.
 *
 * The meaning search planned in docs/graph-search.md replaces steps 1–2 with
 * embeddings and adds a reranker after step 4; it returns the same response.
 */

/** Words that carry no meaning here, in English and French. */
const FILLER = new Set(
  `a an the of for to my on in at by with and or from is it its that which what where how do does i me show find get
  give open used use using this these those all any some
  de du des la le les l d pour mon ma mes sur avec et ou un une au aux dans par qui que quel quelle quels ce cet cette
  ces son sa ses mon est`.split(/\s+/)
)

interface Intent {
  kinds: NodeKind[]
  label: string
  /** Narrower: only these device or step kinds. */
  detail?: string[]
  /** Only what is reached through this relation: "signs in with google" → via "used to sign in to". */
  via?: string[]
  /** How precise the word is: "passkey" (3) says more than "device" (2) or "account" (1). */
  weight: number
}

const INTENTS = new Map<string, Intent>()
const intent = (list: string, value: Intent): void => {
  for (const word of list.split(/\s+/)) INTENTS.set(word, value)
}
intent('device devices appareil appareils', { kinds: ['device'], label: 'Devices', weight: 2 })
intent('phone phones telephone telephones mobile portable', { kinds: ['device'], label: 'Phones', detail: ['phone'], weight: 2 })
intent('laptop laptops computer computers ordinateur ordinateurs mac', { kinds: ['device'], label: 'Computers', detail: ['computer'], weight: 2 })
intent('tablet tablets tablette tablettes ipad', { kinds: ['device'], label: 'Tablets', detail: ['tablet'], weight: 2 })
intent('yubikey yubikeys securitykey securitykeys', { kinds: ['device', 'step'], label: 'Security keys', detail: ['security_key'], weight: 3 })
intent('authentication authenticate authentification auth 2fa mfa twofactor 2step verification', { kinds: ['step'], label: 'Sign-in steps', weight: 1 })
intent('authenticator otp totp', { kinds: ['step'], label: 'Authenticator apps', detail: ['authenticator'], weight: 3 })
intent('code codes', { kinds: ['step'], label: 'Codes', detail: ['authenticator', 'sms', 'email', 'recovery_codes'], weight: 2 })
intent('passkey passkeys', { kinds: ['step'], label: 'Passkeys', detail: ['passkey'], weight: 3 })
intent('recovery backup recuperation secours', { kinds: ['step'], label: 'Recovery codes', detail: ['recovery_codes'], weight: 3 })
intent('sms', { kinds: ['step'], label: 'Text messages', detail: ['sms'], weight: 3 })
intent('prompt', { kinds: ['step'], label: 'Sign-in prompts', detail: ['prompt'], weight: 3 })
intent(
  'password passwords login logins credential credentials account accounts compte comptes identifiant identifiants mdp signin',
  { kinds: ['account'], label: 'Accounts', weight: 1 }
)
intent('secret secrets token tokens key keys api env variable variables cle cles', {
  kinds: ['project-secret', 'account-secret'],
  label: 'Secrets',
  weight: 2
})
intent('apikey apikeys', { kinds: ['project-secret', 'account-secret'], label: 'API keys', weight: 3 })
intent('sshkey sshkeys privatekey privatekeys', { kinds: ['file', 'project-secret', 'account-secret'], label: 'SSH and private keys', weight: 3 })
intent('sign signs signed', { kinds: ['account'], label: 'Accounts that sign in with it', via: ['used to sign in to'], weight: 2 })
intent('recovers recover', { kinds: ['account'], label: 'Accounts it recovers', via: ['recovers'], weight: 2 })
intent('note notes', { kinds: ['note'], label: 'Notes', weight: 2 })
intent('file files ssh certificate certificates cert pem fichier fichiers', { kinds: ['file'], label: 'Files', weight: 2 })
intent('project projects projet projets', { kinds: ['project'], label: 'Projects', weight: 1 })
intent('service services hosting server servers serveur hebergement', { kinds: ['service'], label: 'Services', weight: 1 })
intent('group groups category categories', { kinds: ['group'], label: 'Groups', weight: 1 })

const DECAY = 0.7
const MAX_HOPS = 4
const MIN_QUALITY = 0.45

/** Two neighbouring letters swapped: "githbu" for "github". */
function swapped(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const diff: number[] = []
  for (let i = 0; i < a.length && diff.length <= 2; i++) if (a[i] !== b[i]) diff.push(i)
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]
}

/** Edits needed to turn a into b, giving up past 1 (typos only). */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/** How well a typed word names a term: 1 exact, less for a prefix, a part, a typo. */
function quality(word: string, term: string): number {
  if (term === word) return 1
  if (term.startsWith(word) && word.length >= 2) return 0.6 + 0.4 * (word.length / term.length)
  if (word.length >= 4 && term.includes(word)) return 0.5
  if (word.length >= 5 && (withinOneEdit(word, term) || swapped(word, term))) return 0.6
  const start = term.slice(0, word.length)
  if (word.length >= 5 && (withinOneEdit(word, start) || swapped(word, start))) return 0.55
  return 0
}

function match(graph: VaultGraph, word: string): { node: GraphNode; quality: number }[] {
  const found: { node: GraphNode; quality: number }[] = []
  for (const node of graph.nodes.values()) {
    let best = 0
    for (const term of node.terms) best = Math.max(best, quality(word, term.text) * term.weight)
    if (best >= MIN_QUALITY) found.push({ node, quality: best })
  }
  return found.sort((a, b) => b.quality - a.quality).slice(0, 8)
}

interface Reach {
  score: number
  parent: string | null
  via: string | null
}

/**
 * Spreads out from the matched records. Groups are only ever a start or an end
 * (passing through "Games" would connect every game to every other), and busy
 * records (a phone half the vault uses) pass on less.
 */
function spread(graph: VaultGraph, starts: { node: GraphNode; quality: number }[]): Map<string, Reach> {
  const reach = new Map<string, Reach>()
  let frontier: string[] = []
  for (const { node, quality: q } of starts) {
    if ((reach.get(node.id)?.score ?? 0) < q) reach.set(node.id, { score: q, parent: null, via: null })
    frontier.push(node.id)
  }
  for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      const from = reach.get(id)!
      if (graph.nodes.get(id)!.kind === 'group' && from.parent !== null) continue
      const out = graph.edges.get(id) ?? []
      const busy = out.length > 4 ? 4 / out.length : 1
      for (const edge of out) {
        const score = from.score * DECAY * busy
        if (score > (reach.get(edge.to)?.score ?? 0) + 1e-9) {
          reach.set(edge.to, { score, parent: id, via: edge.via })
          next.push(edge.to)
        }
      }
    }
    frontier = next
  }
  return reach
}

function pathTo(graph: VaultGraph, reach: Map<string, Reach>, id: string): PathStep[] {
  const steps: PathStep[] = []
  let at: string | null = id
  while (at) {
    const r: Reach = reach.get(at)!
    steps.unshift({ node: plain(graph.nodes.get(at)!), via: r.via })
    at = r.parent
  }
  return steps
}

/** The question split into what is wanted, names to find, and filler. */
function read(query: string): { wanted: { intent: Intent; words: string[] }[]; names: string[] } {
  const list = words(query).filter((word) => !FILLER.has(word))
  const wanted: { intent: Intent; words: string[] }[] = []
  const names: string[] = []
  for (let i = 0; i < list.length; i++) {
    const pair = list[i + 1] ? list[i] + list[i + 1] : ''
    const hit = (pair && INTENTS.get(pair)) || INTENTS.get(list[i])
    if (hit) {
      const used = pair && INTENTS.get(pair) ? [list[i], list[++i]] : [list[i]]
      const same = wanted.find((w) => w.intent === hit)
      if (same) same.words.push(...used)
      else wanted.push({ intent: hit, words: used })
    } else {
      names.push(list[i])
    }
  }
  return { wanted, names }
}

/** The record is what the intent asks for (and, for a relation, reached through it). */
function fits(node: SearchNode, intent: Intent, reachedVia?: string | null): boolean {
  if (!intent.kinds.includes(node.kind)) return false
  if (intent.detail && node.detail && !intent.detail.includes(node.detail)) return false
  return !intent.via || (reachedVia != null && intent.via.includes(reachedVia))
}

export function searchGraph(graph: VaultGraph, query: string, limit = 40): SearchResponse {
  const { wanted, names } = read(query)

  // Names, two words at a time first: "auto transfert" → autotransfert.
  const anchors: { words: string; found: { node: GraphNode; quality: number }[] }[] = []
  const unmatched: string[] = []
  // A precise word that asks for a kind can also be a name: "yubikey" is the
  // YubiKey too. Not generic ones ("key"), nor words of a phrase ("ssh key").
  for (const w of wanted) {
    if (w.intent.weight < 3 || w.words.length !== 1) continue
    const found = match(graph, w.words[0]).filter((f) => f.quality >= 0.85)
    if (found.length) anchors.push({ words: w.words[0], found })
  }
  for (let i = 0; i < names.length; i++) {
    const pair = names[i + 1] ? names[i] + names[i + 1] : ''
    const pairFound = pair ? match(graph, pair).filter((f) => f.quality >= 0.8) : []
    if (pairFound.length) {
      anchors.push({ words: `${names[i]} ${names[i + 1]}`, found: pairFound })
      i++
      continue
    }
    const found = match(graph, names[i])
    if (found.length) anchors.push({ words: names[i], found })
    else unmatched.push(names[i])
  }

  // The most precise of the wanted kinds are the answer; the others only qualify
  // it ("device authentication": devices, reached through a sign-in step).
  const top = Math.max(0, ...wanted.map((w) => w.intent.weight))
  const answers = wanted.filter((w) => w.intent.weight === top).map((w) => w.intent)
  const qualifiers = wanted.filter((w) => w.intent.weight < top).map((w) => w.intent)

  const understood: Understood = {
    wants: wanted.map((w) => ({ label: w.intent.label, words: w.words })),
    anchors: anchors.map((a) => ({ words: a.words, nodes: a.found.slice(0, 3).map((f) => plain(f.node)) })),
    unmatched
  }

  let hits: SearchHit[] = []
  if (anchors.length === 0 && answers.length > 0) {
    // "passkeys", "devices": everything of that kind.
    for (const node of graph.nodes.values()) {
      if (answers.some((intent) => !intent.via && fits(node, intent))) {
        hits.push({ node: plain(node), score: 0.5, path: [{ node: plain(node), via: null }], answer: true })
      }
    }
    hits.sort((a, b) => a.node.title.localeCompare(b.node.title))
  } else if (anchors.length > 0) {
    const reaches = anchors.map((a) => spread(graph, a.found))
    const candidates = new Set(reaches.flatMap((r) => [...r.keys()]))
    for (const id of candidates) {
      const scores = reaches.map((r) => r.get(id)?.score ?? 0)
      const covered = scores.filter((s) => s > 0).length / anchors.length
      let score = (scores.reduce((sum, s) => sum + s, 0) / anchors.length) * covered * covered
      const node = graph.nodes.get(id)!
      // Explain it from the farthest name it was reached from: that path tends to
      // pass through the others ("Autotransfert › Coolify › … › iPhone").
      const from = reaches
        .map((r, i) => ({ r, hops: r.has(id) ? pathTo(graph, r, id).length : 0, score: scores[i] }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.hops - a.hops || b.score - a.score)[0]
      const path = pathTo(graph, from.r, id)
      const reachedVia = path.at(-1)?.via
      // A record whose whole name was typed ("games" → the Games group) comes first.
      if (words(node.title).join(' ') === names.join(' ')) score += 0.15
      let answer = false
      if (answers.length) {
        const fitting = answers.find((intent) => fits(node, intent, reachedVia))
        answer = !!fitting
        // Kinds are listed by preference: an SSH key is a file before a text secret.
        if (fitting) score *= 1 - 0.1 * fitting.kinds.indexOf(node.kind)
        if (!answer) score *= answers.some((intent) => intent.kinds.includes(node.kind)) ? 0.5 : 0.3
        if (qualifiers.some((q) => path.slice(0, -1).some((step) => fits(step.node, q, step.via)))) score *= 1.3
      }
      if (score >= 0.05) hits.push({ node: plain(node), score, path, answer })
    }
    hits.sort((a, b) => Number(b.answer) - Number(a.answer) || b.score - a.score)
    const max = Math.max(...hits.map((hit) => hit.score), 1)
    for (const hit of hits) hit.score /= max
    if (!answers.length) {
      // Nothing asked for in particular: the strongest, fully covered ones are the answer.
      const best = hits[0]?.score ?? 0
      for (const hit of hits) hit.answer = hit.score >= best * 0.6
    }
  }
  if (hits.length === 0 && unmatched.length > 0) {
    // Nothing understood: fall back to plain text, so typing an email still finds it.
    const text = query.trim().toLowerCase()
    for (const node of graph.nodes.values()) {
      if (`${node.title} ${node.subtitle}`.toLowerCase().includes(text)) {
        hits.push({ node: plain(node), score: 0.4, path: [{ node: plain(node), via: null }], answer: true })
      }
    }
  }
  return { query, understood, hits: hits.slice(0, limit) }
}

/** What a record is directly connected to, for the preview. */
export function neighbours(graph: VaultGraph, id: string, limit = 8): { node: SearchNode; via: string }[] {
  return (graph.edges.get(id) ?? [])
    .filter((edge) => graph.nodes.get(edge.to)?.kind !== 'group')
    .slice(0, limit)
    .map((edge) => ({ node: plain(graph.nodes.get(edge.to)!), via: edge.via }))
}
