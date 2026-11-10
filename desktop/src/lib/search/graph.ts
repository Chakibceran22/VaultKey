import type {
  AccountDevice,
  AccountLink,
  AccountSecretMeta,
  AccountSummary,
  Device,
  Factor,
  Project,
  SecretMeta,
  Service
} from '@renderer/shared/contracts'
import type { NodeKind, SearchNode } from './types'

/*
 * The vault as a graph: every record a node, every relation an edge both ways,
 * each direction with its own wording ("uses account" / "used by"). Built from
 * metadata only; no secret value is ever part of it.
 */

/** A word a node can be found by; names weigh more than emails or descriptions. */
export interface Term {
  text: string
  weight: number
}

export interface GraphNode extends SearchNode {
  terms: Term[]
}

export interface Edge {
  to: string
  /** How `to` relates to the node the edge leaves: "lives on", "uses account"… */
  via: string
}

export interface VaultGraph {
  nodes: Map<string, GraphNode>
  edges: Map<string, Edge[]>
}

export interface GraphInput {
  accounts: AccountSummary[]
  links: AccountLink[]
  devices: Device[]
  factors: Factor[]
  accountSecrets: AccountSecretMeta[]
  deviceLinks: AccountDevice[]
  projects: Project[]
  services: Service[]
  secrets: SecretMeta[]
  /** Display names, passed in so this file stays free of UI code. */
  names: {
    step: (kind: Factor['kind']) => string
    device: (kind: Device['kind']) => string
    group: (account: AccountSummary) => string
  }
}

/** Parts of names that say nothing on their own. */
const NOISE = new Set(['www', 'com', 'net', 'org', 'fr', 'io', 'co', 'me', 'so', 'gg', 'tv', 'uk', 'eu', 'us', 'http', 'https'])

/** Accents dropped, lowercased, split on anything that is not a-z or 0-9. */
const split = (value: string): string[] =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !NOISE.has(word))

/**
 * "BattleNet.com" → battle, battlenet ("net" is noise); "STRIPE_SECRET_KEY" → stripe,
 * secret, key; accents dropped ("Électricité" → electricite).
 */
export function words(text: string): string[] {
  const spaced = text.replace(/([a-z])([A-Z])/g, '$1 $2')
  const parts = split(spaced)
  // Keep camel-cased names whole as well: "battlenet" finds BattleNet.
  const whole = split(text).filter((word) => !parts.includes(word))
  return [...parts, ...whole]
}

/** A name with accents, case, spaces and punctuation gone: "Lumen-Post" → lumenpost. */
export const squash = (text: string): string => split(text).join('')

const terms = (text: string, weight: number): Term[] => words(text).map((word) => ({ text: word, weight }))

export function buildGraph(input: GraphInput): VaultGraph {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, Edge[]>()
  const add = (node: GraphNode): void => {
    nodes.set(node.id, node)
    edges.set(node.id, [])
  }
  /** Both directions, each with its own wording. */
  const link = (from: string, to: string, forward: string, back: string): void => {
    if (!nodes.has(from) || !nodes.has(to) || from === to) return
    edges.get(from)!.push({ to, via: forward })
    edges.get(to)!.push({ to: from, via: back })
  }

  const accountName = new Map(input.accounts.map((a) => [a.id, a.domainName]))
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]))

  for (const account of input.accounts) {
    add({
      id: `account:${account.id}`,
      kind: 'account',
      title: account.domainName,
      subtitle: account.username ? `${account.email}, ${account.username}` : account.email,
      to: `/accounts/${account.id}`,
      terms: [
        ...terms(account.domainName, 1),
        ...terms(account.username ?? '', 0.8),
        ...terms(account.email, 0.6)
      ]
    })
  }
  const groups = new Map<string, number[]>()
  for (const account of input.accounts) {
    const name = input.names.group(account)
    groups.set(name, [...(groups.get(name) ?? []), account.id])
  }
  for (const [name, members] of groups) {
    add({
      id: `group:${name}`,
      kind: 'group',
      title: name,
      subtitle: `${members.length} account${members.length === 1 ? '' : 's'}`,
      to: '/accounts',
      terms: terms(name, 0.9)
    })
    for (const id of members) link(`group:${name}`, `account:${id}`, 'includes', 'in group')
  }
  for (const project of input.projects) {
    add({
      id: `project:${project.id}`,
      kind: 'project',
      title: project.name,
      subtitle: project.description || 'Project',
      to: `/projects/${project.id}`,
      terms: [...terms(project.name, 1), ...terms(project.description, 0.5)]
    })
  }
  for (const service of input.services) {
    add({
      id: `service:${service.id}`,
      kind: 'service',
      title: service.name,
      subtitle: `Service in ${projectName.get(service.projectId) ?? 'a project'}`,
      to: `/projects/${service.projectId}?show=services`,
      terms: [...terms(service.name, 1), ...terms(service.url, 0.7)]
    })
  }
  for (const device of input.devices) {
    add({
      id: `device:${device.id}`,
      kind: 'device',
      title: device.name,
      subtitle: input.names.device(device.kind),
      to: `/devices?open=${device.id}`,
      detail: device.kind,
      terms: [...terms(device.name, 1), ...terms(device.notes, 0.4)]
    })
  }
  for (const factor of input.factors) {
    const name = input.names.step(factor.kind)
    const owner = accountName.get(factor.accountId) ?? 'an account'
    add({
      id: `step:${factor.id}`,
      kind: 'step',
      title: name,
      subtitle: factor.label ? `${factor.label}, for ${owner}` : `For ${owner}`,
      to: `/accounts/${factor.accountId}`,
      detail: factor.kind,
      terms: [...terms(name, 0.8), ...terms(factor.label, 0.9)]
    })
  }
  for (const secret of input.accountSecrets) {
    const kind: NodeKind = secret.kind === 'note' ? 'note' : 'account-secret'
    add({
      id: `${kind}:${secret.id}`,
      kind,
      title: secret.name,
      subtitle: `${secret.kind === 'note' ? 'Note' : 'Secret'} in ${accountName.get(secret.accountId) ?? 'an account'}`,
      to: `/accounts/${secret.accountId}?show=secrets`,
      terms: terms(secret.name, 1)
    })
  }
  for (const secret of input.secrets) {
    const kind: NodeKind = secret.kind === 'file' ? 'file' : 'project-secret'
    add({
      id: `${kind}:${secret.id}`,
      kind,
      title: secret.name,
      subtitle: `${secret.kind === 'file' ? 'File' : 'Secret'} in ${projectName.get(secret.projectId) ?? 'a project'}`,
      to: `/projects/${secret.projectId}?show=${secret.kind === 'file' ? 'files' : 'secrets'}`,
      // Its description too: "the root ssh key" finds id_ed25519 described that way.
      terms: [...terms(secret.name, 1), ...terms(secret.description, 0.5)]
    })
  }

  // Relations, worded from each side.
  for (const l of input.links) {
    if (l.kind === 'sign_in') {
      link(`account:${l.accountId}`, `account:${l.linkedAccountId}`, 'signs in with', 'used to sign in to')
    } else {
      link(`account:${l.accountId}`, `account:${l.linkedAccountId}`, 'recovered by', 'recovers')
    }
  }
  for (const factor of input.factors) {
    link(`account:${factor.accountId}`, `step:${factor.id}`, 'second step', 'protects')
    if (factor.deviceId) link(`step:${factor.id}`, `device:${factor.deviceId}`, 'lives on', 'holds')
  }
  for (const l of input.deviceLinks) {
    link(`account:${l.accountId}`, `device:${l.deviceId}`, 'signed in on', 'signed in to')
    // What it does there ("authenticator") names both ends a little.
    nodes.get(`account:${l.accountId}`)?.terms.push(...terms(l.note, 0.4))
    nodes.get(`device:${l.deviceId}`)?.terms.push(...terms(l.note, 0.4))
  }
  for (const secret of input.accountSecrets) {
    const kind = secret.kind === 'note' ? 'note' : 'account-secret'
    link(`account:${secret.accountId}`, `${kind}:${secret.id}`, 'keeps', 'kept with')
  }
  for (const service of input.services) {
    link(`project:${service.projectId}`, `service:${service.id}`, 'has service', 'in project')
    // Every account it uses ("coolify account" finds them all), and the role each has
    // there as a word of that account ("coolify admin" finds the admin one).
    for (const { accountId, role } of service.accounts) {
      link(`service:${service.id}`, `account:${accountId}`, 'uses account', 'used by')
      nodes.get(`account:${accountId}`)?.terms.push(...terms(role, 0.7))
    }
  }
  for (const secret of input.secrets) {
    const id = `${secret.kind === 'file' ? 'file' : 'project-secret'}:${secret.id}`
    link(`project:${secret.projectId}`, id, 'keeps', 'in project')
    if (secret.serviceId) link(`service:${secret.serviceId}`, id, 'uses', 'for service')
  }
  return { nodes, edges }
}

/** A node as search shows it: without the words it is found by. */
export function plain(node: GraphNode): SearchNode {
  const { terms: _terms, ...rest } = node
  return rest
}
