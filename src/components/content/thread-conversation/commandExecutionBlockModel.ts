export interface CommandExecutionBlockState {
  commandLabel: string
  outputDomId: string
  mountedOutput: string | null
}

export interface CommandExecutionBlockStateInput {
  instanceId: string
  command: string
  commandFallback: string
  output: string
  emptyOutputLabel: string
  expanded: boolean
}

/** Keep large output out of render state until the command is expanded. */
export function buildCommandExecutionBlockState(
  input: CommandExecutionBlockStateInput,
): CommandExecutionBlockState {
  return {
    commandLabel: input.command || input.commandFallback,
    outputDomId: `command-output-${encodeURIComponent(input.instanceId)}`,
    mountedOutput: input.expanded ? (input.output || input.emptyOutputLabel) : null,
  }
}
