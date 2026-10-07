import { ProviderError, type TutorMessage } from "./types";

// Only the final answer crosses the display/storage boundary. Never return a
// reasoning field, even when the provider ignored its suppression setting.
export function safeTutorResponse(text: string, messages: TutorMessage[] = []) {
  const content = text.replace(/<\s*(think|thinking)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "").trim();
  const reasoningDetected = content !== text.trim();
  const leakedTrace = /<\s*\/?\s*(?:think|thinking)\b|(?:here(?:'s| is)|this is)\s+(?:my |a |the )?(?:thinking process|reasoning process)|(?:^|\n)\s*(?:\*\*|#{1,6}\s*)?(?:analysis|internal reasoning|chain[ -]of[ -]thought|system prompt|system instructions)\s*[:\n]|(?:I (?:need|must|should) to|the (?:user|learner) (?:asks|wants|said)).{0,100}(?:system prompt|instructions|respond|answer)|You are Patch, the Codestead tutor/i.test(content);
  const normalized = content.replace(/\s+/g, " ").toLowerCase();
  const echoesSystem = messages.some((message) => message.role === "system" &&
    message.content.split(/\n+/).some((line) => {
      const instruction = line.trim().replace(/\s+/g, " ").toLowerCase();
      return instruction.length >= 60 && normalized.includes(instruction);
    }));
  if (leakedTrace || echoesSystem) {
    throw new ProviderError("This model returns reasoning text. Its response was blocked.", "REASONING_LEAK");
  }
  if (!content) throw new ProviderError("Provider returned no tutor text.", reasoningDetected ? "REASONING_LEAK" : "BAD_RESPONSE");
  return { content, reasoningDetected };
}
