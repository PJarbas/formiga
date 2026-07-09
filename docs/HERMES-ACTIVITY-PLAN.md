# Plano: Activity Recording para Hermes

## Contexto

O Pi emite eventos JSON em stdout durante a execução (toolcall_start, toolcall_result, thinking, etc.), permitindo captura em tempo real via `activity-recorder.ts`.

O Hermes tem uma abordagem diferente:
1. **Output**: Texto plano em stdout (não JSON estruturado)
2. **Armazenamento**: SQLite local em `~/.hermes/state.db` com schema rico
3. **Sessions**: Cada execução cria uma sessão com ID único (ex: `20260623_143301_d08450`)
4. **Messages**: Tabela com role (user/assistant/tool), tool_calls, reasoning, etc.

## Estratégia de Implementação

### Opção A: Polling do state.db (Recomendada)

Após o Hermes completar, lemos a sessão do `state.db` e importamos os eventos para o banco do Formiga.

**Prós:**
- Dados já estruturados e completos
- Não requer modificação do Hermes
- Inclui reasoning, timestamps precisos, token counts

**Contras:**
- Não é real-time (apenas pós-execução)
- Precisa do session_id que Hermes gera

### Opção B: Export JSONL em Tempo Real

Usar `hermes sessions export --session-id <id> -` durante a execução.

**Problema:** Não temos o session_id até o Hermes finalizar.

### Opção C: Usar --pass-session-id + Polling Periódico

O Hermes tem flag `--pass-session-id` que inclui o session_id no system prompt. Podemos:
1. Gerar um session_id customizado
2. Passar para Hermes
3. Fazer polling periódico do state.db enquanto roda

**Problema:** Hermes gera seu próprio session_id, não aceita um externo.

## Implementação Proposta (Opção A)

### 1. Capturar Session ID do Output

O Hermes emite `session_id: <id>` no final do stdout. Já temos código que filtra isso:

```typescript
// hermes-runner.ts linha 264-277
filteredStdout = tail
  .split("\n")
  .filter((line) => !/^session_id:\s*\S+/.test(line.trim()))
  .join("\n")
  .trim();
```

Modificar para **extrair** o session_id antes de filtrar.

### 2. Importar Eventos Pós-Execução

Criar `hermes-activity-importer.ts`:

```typescript
interface HermesMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: ToolCall[] | null;
  tool_name: string | null;
  timestamp: number;
  reasoning: string | null;
}

async function importHermesSession(
  sessionId: string,
  context: ActivityContext
): Promise<void> {
  const hermesDbPath = path.join(os.homedir(), '.hermes', 'state.db');
  const db = new Database(hermesDbPath, { readonly: true });
  
  const messages = db.prepare(`
    SELECT * FROM messages 
    WHERE session_id = ? 
    ORDER BY timestamp ASC
  `).all(sessionId);
  
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      // Registrar tool call start
      for (const tc of JSON.parse(msg.tool_calls)) {
        await recordAgentEvent({
          ...context,
          eventType: 'tool_call',
          toolName: tc.function.name,
          toolArgs: JSON.parse(tc.function.arguments),
          toolStatus: 'running',
        });
      }
    }
    
    if (msg.role === 'tool') {
      // Registrar tool result
      await recordAgentEvent({
        ...context,
        eventType: 'tool_call',
        toolName: msg.tool_name,
        toolResult: msg.content?.slice(0, 200),
        toolStatus: JSON.parse(msg.content)?.error ? 'failed' : 'completed',
      });
    }
    
    if (msg.reasoning) {
      await recordAgentEvent({
        ...context,
        eventType: 'thinking',
        thinking: msg.reasoning.slice(0, 500),
      });
    }
  }
}
```

### 3. Integrar no hermes-runner.ts

```typescript
export async function runHermes(
  prompt: string,
  options: RunPiOptions = {},
): Promise<string> {
  // ... código existente ...
  
  // Extrair session_id antes de filtrar
  const sessionIdMatch = rawStdout.match(/^session_id:\s*(\S+)/m);
  const hermesSessionId = sessionIdMatch?.[1];
  
  // Filtrar e retornar stdout...
  
  // Importar eventos pós-execução (fire-and-forget)
  if (hermesSessionId && options.activityContext) {
    importHermesSession(hermesSessionId, options.activityContext)
      .catch(err => logger.warn('Failed to import hermes session', { err }));
  }
  
  return filteredStdout;
}
```

### 4. Atualizar polling-round.ts

Passar `activityContext` também para `runHermes`:

```typescript
if (harnessType === "hermes") {
  output = await runHermes(pollingPrompt, {
    timeout,
    workdir: workingDirectoryForHarness,
    env: { ... },
    onSpawn,
    outputFile,
    activityContext,  // Adicionar aqui
  });
}
```

## Estrutura de Arquivos

```
src/installer/scheduler/
├── activity-recorder.ts       # Existente (pi)
├── hermes-activity-importer.ts # Novo (hermes)
├── hermes-runner.ts           # Modificar
└── polling-round.ts           # Já modificado
```

## Diferenças Pi vs Hermes

| Aspecto | Pi | Hermes |
|---------|-----|--------|
| Output | JSON streaming | Texto plano |
| Captura | Real-time | Pós-execução |
| Fonte | stdout | state.db |
| Session ID | Em eventos JSON | Final do stdout |
| Reasoning | thinking events | Campo reasoning |

## Limitações

1. **Não é real-time**: Eventos aparecem no dashboard apenas após Hermes terminar
2. **Dependência do SQLite**: Precisa do better-sqlite3 ou similar
3. **Path fixo**: Assume `~/.hermes/state.db`

## Melhorias Futuras

1. **Real-time via polling**: Thread de background fazendo polling do state.db durante execução
2. **WebSocket do Hermes**: Se Hermes expuser API de eventos, usar isso
3. **Unificação**: Criar interface comum para Pi e Hermes activity

## Estimativa de Esforço

- Criar `hermes-activity-importer.ts`: 2h
- Modificar `hermes-runner.ts`: 1h
- Testes e ajustes: 1h
- **Total: ~4h**
