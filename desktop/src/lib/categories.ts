import {
  Bank,
  Brain,
  Briefcase,
  Buildings,
  ChatsCircle,
  Code,
  FilmStrip,
  FolderSimple,
  GameController,
  IdentificationCard,
  ShoppingBag,
  Train
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

/**
 * The groups accounts are shown in, in this order. An account is placed by hand
 * (stored in the vault) or, until then, by a guess from its website's name. The
 * guess lives here, not in the database, so it can get better without a migration.
 */
export const CATEGORIES = [
  { name: 'Email and identity', icon: IdentificationCard },
  { name: 'Developer and cloud', icon: Code },
  { name: 'AI', icon: Brain },
  { name: 'Work', icon: Briefcase },
  { name: 'Money', icon: Bank },
  { name: 'Social and chat', icon: ChatsCircle },
  { name: 'Games', icon: GameController },
  { name: 'Shopping', icon: ShoppingBag },
  { name: 'Streaming and media', icon: FilmStrip },
  { name: 'Travel', icon: Train },
  { name: 'Admin and bills', icon: Buildings },
  { name: 'Other', icon: FolderSimple }
] as const satisfies readonly { name: string; icon: Icon }[]

export const OTHER = 'Other'

/** Words in a website's name, and the group they point to. */
const KNOWN: Record<string, string[]> = {
  'Email and identity': [
    'google', 'gmail', 'apple', 'icloud', 'appleid', 'android', 'microsoft', 'outlook', 'hotmail', 'live',
    'proton', 'protonmail', 'yahoo', 'tutanota', 'tuta', 'fastmail', 'gmx', 'zoho', 'yandex', 'aol', 'mail',
    'franceconnect', 'okta', 'auth0', 'bitwarden', '1password', 'lastpass', 'dashlane', 'samsung', 'huawei',
    'xiaomi'
  ],
  'Developer and cloud': [
    'github', 'gitlab', 'bitbucket', 'aws', 'amazonaws', 'azure', 'gcp', 'vercel', 'netlify', 'coolify',
    'docker', 'dockerhub', 'digitalocean', 'heroku', 'cloudflare', 'supabase', 'firebase', 'npm', 'npmjs',
    'hetzner', 'ovh', 'ovhcloud', 'render', 'railway', 'fly', 'linode', 'vultr', 'scaleway', 'expo',
    'jetbrains', 'postman', 'sentry', 'mongodb', 'planetscale', 'neon', 'redis', 'stackoverflow', 'godaddy',
    'namecheap', 'gandi', 'porkbun', 'hostinger', 'o2switch', 'pypi', 'crates', 'replit', 'codepen',
    'kaggle', 'developer', 'twilio', 'resend', 'sendgrid', 'mailgun', 'algolia',
    'datadog', 'grafana', 'portainer', 'proxmox', 'tailscale', 'ngrok', 'pm2', 'jenkins', 'circleci', 'unity',
    'unrealengine', 'godot', 'appwrite', 'pocketbase', 'clerk', 'mapbox'
  ],
  AI: [
    'claude', 'anthropic', 'openai', 'chatgpt', 'mistral', 'huggingface', 'perplexity', 'midjourney',
    'gemini', 'copilot', 'cursor', 'poe', 'groq', 'replicate', 'deepseek', 'elevenlabs', 'runwayml',
    'suno', 'characterai', 'ollama', 'lmstudio', 'openrouter', 'windsurf', 'v0', 'lovable', 'bolt'
  ],
  Work: [
    'notion', 'figma', 'linear', 'slack', 'trello', 'atlassian', 'jira', 'confluence', 'asana', 'clickup',
    'monday', 'miro', 'canva', 'zoom', 'teams', 'office', 'office365', 'dropbox', 'docusign', 'calendly',
    'airtable', 'loom', 'adobe', 'evernote', 'todoist', 'obsidian', 'grammarly', 'framer', 'webflow', 'wix',
    'squarespace', 'wordpress', 'upwork', 'fiverr', 'malt', 'indeed', 'welcometothejungle', 'hubspot',
    'salesforce', 'pipedrive', 'odoo', 'sage', 'pennylane', 'payfit', 'lucca', 'cadencia'
  ],
  Money: [
    'paypal', 'stripe', 'revolut', 'wise', 'transferwise', 'n26', 'binance', 'coinbase', 'kraken', 'bybit',
    'okx', 'kucoin', 'metamask', 'ledger', 'dukascopy', 'etoro', 'degiro', 'tradingview', 'ibkr',
    'interactivebrokers', 'trading212', 'boursorama', 'boursobank', 'bnp', 'bnpparibas', 'creditagricole',
    'societegenerale', 'lcl', 'caissedepargne', 'banquepopulaire', 'hellobank', 'fortuneo', 'qonto', 'shine',
    'lydia', 'sumup', 'klarna', 'venmo', 'cashapp', 'monzo', 'chase', 'amex', 'americanexpress', 'payoneer',
    'skrill', 'neteller', 'bank', 'banque', 'crypto', 'cryptocom', 'mtpelerin', 'trade', 'forex', 'xtb'
  ],
  'Social and chat': [
    'discord', 'telegram', 'whatsapp', 'signal', 'facebook', 'messenger', 'instagram', 'twitter', 'x',
    'threads', 'linkedin', 'reddit', 'tiktok', 'snapchat', 'pinterest', 'tumblr', 'mastodon', 'bluesky',
    'bsky', 'quora', 'medium', 'substack', 'meetup', 'tinder', 'bumble', 'hinge', 'skype', 'viber', 'line'
  ],
  Games: [
    'steam', 'steampowered', 'steamcommunity', 'epicgames', 'battlenet', 'blizzard', 'bethesda', 'riot',
    'riotgames', 'leagueoflegends', 'valorant', 'ubisoft', 'ea', 'origin', 'xbox', 'playstation', 'psn',
    'nintendo', 'gog', 'roblox', 'minecraft', 'mojang', 'afkarena', 'lilith', 'supercell', 'rockstar',
    'rockstargames', 'activision', 'faceit', 'chess', 'itch', 'curseforge', 'hoyoverse', 'mihoyo',
    'genshin', 'garena', 'twitch', 'kick', 'warframe', 'wargaming', 'pubg', 'fortnite', 'battle', 'game',
    'games', 'gaming'
  ],
  Shopping: [
    'amazon', 'ebay', 'aliexpress', 'alibaba', 'temu', 'shein', 'vinted', 'leboncoin', 'cdiscount', 'fnac',
    'darty', 'boulanger', 'zalando', 'asos', 'etsy', 'ikea', 'decathlon', 'walmart', 'bestbuy', 'ldlc',
    'backmarket', 'rakuten', 'veepee', 'ubereats', 'deliveroo', 'justeat', 'shop', 'store'
  ],
  'Streaming and media': [
    'netflix', 'spotify', 'youtube', 'disney', 'disneyplus', 'primevideo', 'hbo', 'max', 'deezer',
    'crunchyroll', 'soundcloud', 'canal', 'canalplus', 'molotov', 'dazn', 'plex', 'audible', 'kindle',
    'goodreads', 'letterboxd', 'imdb', 'paramount', 'appletv', 'tidal', 'qobuz', 'anilist', 'myanimelist'
  ],
  Travel: [
    'uber', 'airbnb', 'booking', 'expedia', 'sncf', 'sncfconnect', 'ouigo', 'blablacar', 'ryanair',
    'easyjet', 'airfrance', 'lime', 'trainline', 'tripadvisor', 'skyscanner', 'kayak', 'flixbus', 'ratp',
    'transavia', 'vueling', 'getaround', 'heetch', 'freenow'
  ],
  'Admin and bills': [
    'impots', 'ameli', 'caf', 'ants', 'urssaf', 'francetravail', 'poleemploi', 'doctolib', 'laposte',
    'edf', 'engie', 'totalenergies', 'free', 'sfr', 'orange', 'bouygues', 'bouyguestelecom', 'sosh',
    'redbysfr', 'mutuelle', 'gouv', 'servicepublic', 'cpam', 'vinci', 'mma', 'axa', 'maif', 'macif'
  ]
}

const LOOKUP = new Map<string, string>()
for (const [category, words] of Object.entries(KNOWN)) {
  for (const word of words) if (!LOOKUP.has(word)) LOOKUP.set(word, category)
}

/** Words that only hint at a group: used when no specific word is in the name. */
const GENERIC = new Set(['shop', 'store', 'game', 'games', 'gaming', 'battle', 'bank', 'banque', 'crypto', 'trade', 'forex', 'developer', 'mail', 'gouv'])

/** Parts of a name that say nothing about the site on their own. */
const NOISE = new Set(['www', 'com', 'net', 'org', 'fr', 'io', 'app', 'co', 'me', 'ai', 'dev', 'so', 'gg', 'tv', 'uk', 'de', 'be', 'eu', 'us', 'login', 'account', 'accounts', 'my', 'id'])

/**
 * The group a website's name suggests: "BattleNet.com" and "battle.net" → Games,
 * "coolify.example.fr" → Developer and cloud. Words are tried in order, then each
 * pair joined ("epic" + "games"); a name with no known word is "Other".
 */
export function guessCategory(website: string): string {
  const words = website
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !NOISE.has(word))
  const candidates = words.flatMap((word, i) => (words[i + 1] ? [word + words[i + 1], word] : [word]))
  // Specific words win over generic ones: "store" in store.steampowered.com.
  const specific = candidates.find((word) => LOOKUP.has(word) && !GENERIC.has(word))
  const generic = candidates.find((word) => LOOKUP.has(word))
  const found = specific ?? generic
  if (found) return LOOKUP.get(found)!
  // A typo in a known name: "Intagram" is Instagram.
  for (const word of candidates) {
    if (word.length < 6) continue
    for (const [known, category] of LOOKUP) {
      if (known.length >= 6 && !GENERIC.has(known) && oneEditApart(word, known)) return category
    }
  }
  return OTHER
}

/** One letter added, dropped or changed. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return a === b
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
    } else {
      if (++edits > 1) return false
      if (a.length >= b.length) i++
      if (b.length >= a.length) j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/** Where an account is shown: the group chosen for it, or the guess. */
export function categoryOf(account: { domainName: string; category: string | null }): string {
  return account.category ?? guessCategory(account.domainName)
}

export function categoryIcon(name: string): Icon {
  return CATEGORIES.find((c) => c.name === name)?.icon ?? FolderSimple
}

/** Known groups in their fixed order, then any other names, then Other. */
export function categoryOrder(a: string, b: string): number {
  const rank = (name: string): number => {
    const index = CATEGORIES.findIndex((c) => c.name === name)
    if (name === OTHER) return 1000
    return index === -1 ? 500 : index
  }
  return rank(a) - rank(b) || a.localeCompare(b)
}
