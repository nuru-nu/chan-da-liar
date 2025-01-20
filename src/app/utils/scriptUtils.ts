import { ConversationRole } from '../states/types';

export interface ScriptMessage {
  role: ConversationRole;
  text: string;
}

export const cleanRegex = /<[^>]*>|\[[^\]]*\]|\([^)]*\)/g;
export function removeMeta(content: string) {
  content = content.replace(cleanRegex, '');
  return { content };
}

export function parseScript(script: string): ScriptMessage[] {
  const messages: ScriptMessage[] = [];
  let currentSpeaker = '';
  let currentEmotion = '';

  const lines = script
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  for (let line of lines) {
    if (line.endsWith(':')) {
      const speakerMatch = line.match(/^(.*?)(?:\s*\((.*?)\))?\s*:$/);
      if (speakerMatch) {
        currentSpeaker = speakerMatch[1].trim();
        currentEmotion = speakerMatch[2] || '';
      }
      continue;
    }

    if (line.startsWith('(') && line.endsWith(')')) {
      messages.push({
        role: 'user',
        text: line
      });
      continue;
    }

    if (currentSpeaker) {
      const text = currentEmotion
        ? `(${currentSpeaker}) [${currentEmotion}] ${line}`
        : `(${currentSpeaker}) ${line}`;

      messages.push({
        role: currentSpeaker === 'Deliar' ? 'assistant' : 'user',
        text
      });
    }
  }

  return messages;
}

