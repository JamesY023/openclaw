const COMMAND_SENDER_AUTHORITY = Symbol("openclaw.commandSenderAuthority");
const TALK_TOOL_SENDER_AUTHORITY = Symbol("openclaw.talkToolSenderAuthority");

type CommandSenderAuthority = () => string | undefined;
type CommandSenderContext = {
  [COMMAND_SENDER_AUTHORITY]?: CommandSenderAuthority;
  [TALK_TOOL_SENDER_AUTHORITY]?: CommandSenderAuthority;
};

/** Keep the live authority owner through internal context and client copies. */
export function withCommandSenderAuthority<T extends object>(
  context: T,
  authority: CommandSenderAuthority | undefined,
  talkToolSender?: CommandSenderAuthority,
): T {
  return {
    ...context,
    [COMMAND_SENDER_AUTHORITY]: authority,
    [TALK_TOOL_SENDER_AUTHORITY]: talkToolSender,
  };
}

export function getCommandSenderAuthority(
  context: object | null | undefined,
): CommandSenderAuthority | undefined {
  // SAFETY: Only this module-private symbol's typed producer supplies the resolver.
  return (context as CommandSenderContext | null | undefined)?.[COMMAND_SENDER_AUTHORITY];
}

/** Only the trusted Talk consult client may attach a live requester for tool hooks. */
export function getTalkToolSenderAuthority(
  context: object | null | undefined,
): CommandSenderAuthority | undefined {
  return (context as CommandSenderContext | null | undefined)?.[TALK_TOOL_SENDER_AUTHORITY];
}

export function copyTalkToolSenderAuthority(source: object, target: object): void {
  const authority = getTalkToolSenderAuthority(source);
  if (authority) {
    (target as CommandSenderContext)[TALK_TOOL_SENDER_AUTHORITY] = authority;
  }
}
