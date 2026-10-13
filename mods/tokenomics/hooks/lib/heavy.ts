import type { SessionContextBreakdown } from 'claude-code'

import type { HeavyItem } from '../../types'

import { formatTokens } from './format'

type Detail = (b: SessionContextBreakdown) => string[]
type Rule = { match: string; label: string; hintOver: number; hint: string; details?: Detail }

/** Biggest first, the few that matter. */
const TOP_DETAILS = 3

const shortPath = (path: string): string => path.split('/').filter(Boolean).slice(-2).join('/')

const memoryDetails: Detail = b =>
  [...(b.memoryFiles ?? [])]
    .sort((a, c) => c.tokens - a.tokens)
    .slice(0, TOP_DETAILS)
    .map(m => `${m.type}: ${shortPath(m.path)}  ${formatTokens(m.tokens)} tok`)

const skillDetails: Detail = b => {
  const skills = b.skills
  if (skills === undefined) return []
  const head =
    skills.includedSkills < skills.totalSkills
      ? `${skills.totalSkills} 個（一覧に入るのは ${skills.includedSkills} 個で、残りはモデルに見えていません）`
      : `${skills.totalSkills} 個`
  const biggest = [...skills.skillFrontmatter]
    .sort((a, c) => c.tokens - a.tokens)
    .slice(0, TOP_DETAILS)
    .map(s => `${s.name}${s.pluginName === undefined ? '' : `（${s.pluginName}）`}  ${formatTokens(s.tokens)} tok`)
  return [head, ...biggest]
}

const mcpDetails: Detail = b => {
  // What is loaded is in the window now; what is not is held back until a tool is used, so it costs nothing yet.
  const byServer = new Map<string, { tools: number; loaded: number; held: number; heldCount: number }>()
  for (const tool of b.mcpTools ?? []) {
    const server = byServer.get(tool.serverName) ?? { tools: 0, loaded: 0, held: 0, heldCount: 0 }
    server.tools += 1
    if (tool.isLoaded) {
      server.loaded += tool.tokens
    } else {
      server.held += tool.tokens
      server.heldCount += 1
    }
    byServer.set(tool.serverName, server)
  }
  return [...byServer.entries()]
    .sort((a, c) => c[1].loaded + c[1].held - (a[1].loaded + a[1].held))
    .slice(0, TOP_DETAILS)
    .map(
      ([name, s]) =>
        `${name}: ${s.tools} 個  いま ${formatTokens(s.loaded)} tok` +
        (s.heldCount > 0 ? `（未読み込み ${s.heldCount} 個は、使うときに ＋${formatTokens(s.held)}）` : ''),
    )
}

const agentDetails: Detail = b =>
  [...(b.agents ?? [])]
    .sort((a, c) => c.tokens - a.tokens)
    .slice(0, TOP_DETAILS)
    .map(a => `${a.agentType}  ${formatTokens(a.tokens)} tok`)

const commandDetails: Detail = b => (b.slashCommands === undefined ? [] : [`${b.slashCommands.totalCommands} 個`])

// A category is named by /context in English; the engine stamps `kind`, but not which category it is.
const RULES: Rule[] = [
  {
    match: 'mcp',
    label: 'MCP のツール定義',
    hintOver: 8_000,
    hint: 'ツール定義は、既定では使うときまで読み込まれません。使っていないサーバーは /mcp で無効にできます。',
    details: mcpDetails,
  },
  {
    match: 'memory',
    label: 'CLAUDE.md などのメモリ',
    hintOver: 3_000,
    hint: '200 行以内が目安です。手順の説明はスキルに移すと、使うときだけ読み込まれます。',
    details: memoryDetails,
  },
  { match: 'agent', label: 'カスタムエージェント', hintOver: 3_000, hint: '使わないエージェントは外せます。', details: agentDetails },
  {
    match: 'skill',
    label: 'スキル一覧',
    hintOver: 3_000,
    hint: 'スキルの frontmatter に disable-model-invocation: true を付けると、一覧に載らず、/名前 で呼び出せます。使わないプラグインは無効にできます。',
    details: skillDetails,
  },
  { match: 'slash', label: 'スラッシュコマンド一覧', hintOver: 3_000, hint: '使わないコマンドは外せます。', details: commandDetails },
  { match: 'system tools', label: '組み込みツール', hintOver: Infinity, hint: '' },
  { match: 'system prompt', label: 'システムプロンプト', hintOver: Infinity, hint: '' },
  { match: 'message', label: '会話履歴', hintOver: Infinity, hint: '' },
]

/** If this share of what is in use is the conversation itself, only a summary or a fresh start helps. */
const CONVERSATION_SHARE = 0.5

export const heavyFrom = (b: SessionContextBreakdown, top = 6): HeavyItem[] => {
  const used = b.categories.filter(c => c.kind === 'used' && c.tokens > 0)
  const total = used.reduce((sum, c) => sum + c.tokens, 0)

  // The engine may list one thing in two rows (MCP tools, and those held back until used): one line for it.
  const grouped = new Map<string, { rule: Rule | undefined; tokens: number }>()
  for (const c of used) {
    const rule = RULES.find(r => c.name.toLowerCase().includes(r.match))
    const label = rule?.label ?? c.name
    const prior = grouped.get(label)
    grouped.set(label, { rule, tokens: (prior?.tokens ?? 0) + c.tokens })
  }

  return [...grouped.entries()]
    .sort((a, c) => c[1].tokens - a[1].tokens)
    .slice(0, top)
    .map(([label, { rule, tokens }]) => {
      const item: HeavyItem = { name: label, tokens }
      if (rule !== undefined && tokens >= rule.hintOver) {
        item.hint = rule.hint
      } else if (rule?.match === 'message' && total > 0 && tokens / total >= CONVERSATION_SHARE) {
        item.hint = '会話そのものが中心です。要約するか新しく始めると、いちばん軽くなります。'
      }
      const details = rule?.details?.(b) ?? []
      if (details.length > 0) item.details = details
      return item
    })
}
