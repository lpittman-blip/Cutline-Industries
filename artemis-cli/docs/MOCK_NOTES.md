# Artemis CLI: code survey (mock run)

Status: reviewed

Task: Survey the Artemis CLI tools and write notes

## Exported symbols
- `src/agent/loop.ts:49` export function systemPrompt(root: string, mode: Mode, extra = ""): string
- `src/agent/loop.ts:95` export class Agent
- `src/agent/mock.ts:24` export function mockContext(messages: ChatMessage[], toolNames: string[]): MockContext
- `src/agent/mock.ts:86` export class MockProvider implements Provider
- `src/agent/openai.ts:39` export class OpenAIProvider implements Provider
- `src/cli.tsx:43` export function parseArgs(argv: string[]): Flags
- `src/config.ts:17` export function artemisHome(): string
- `src/config.ts:20` export function configPath(): string
- `src/config.ts:24` export function loadConfig(): StoredConfig
- `src/config.ts:32` export function saveConfig(cfg: StoredConfig): string
- `src/config.ts:41` export function configExists(): boolean
- `src/config.ts:46` export function upstreamFromEnv(env = process.env): { baseUrl: string; apiKey?: string; model: string; keySource?: string }
- `src/config.ts:70` export function resolveProvider(o: ResolveOpts, env = process.env): { provider: Provider; connection: Connection; target: string }
- `src/print.ts:6` export async function runPrint(opts:
- `src/tools/index.ts:31` export function normalizePlan(v: unknown): PlanStep[]
