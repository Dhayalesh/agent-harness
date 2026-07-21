import type { AgentMessage } from '../core/messages.js';

export function exportTranscriptJson(messages: readonly AgentMessage[]): string {
  return `${JSON.stringify(messages, null, 2)}\n`;
}

export function exportTranscriptMarkdown(messages: readonly AgentMessage[]): string {
  return `${messages
    .map((message) => {
      const body = message.content
        .map((block) => {
          if (block.type === 'text') return block.text;
          if (block.type === 'tool_call') {
            return `**Tool call: ${block.name}**\n\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``;
          }
          return `**Tool result (${block.isError ? 'error' : 'success'}):**\n\n\`\`\`text\n${block.content}\n\`\`\``;
        })
        .join('\n\n');
      return `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${body}`;
    })
    .join('\n\n')}\n`;
}
