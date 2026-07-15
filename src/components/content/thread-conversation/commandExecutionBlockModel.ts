export interface CommandExecutionBlockState {
  commandLabel: string
  outputDomId: string
  mountedOutput: string
}

export interface CommandExecutionBlockStateInput {
  instanceId: string
  command: string
  commandFallback: string
  output: string
  emptyOutputLabel: string
  expanded: boolean
}

export function buildCommandExecutionBlockState(
  input: CommandExecutionBlockStateInput,
): CommandExecutionBlockState {
  return {
    commandLabel: input.command || input.commandFallback,
    outputDomId: `command-output-${encodeURIComponent(input.instanceId)}`,
    mountedOutput: input.output || input.emptyOutputLabel,
  }
}
