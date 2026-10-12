import type { Client } from 'discord.js';
import type { StoredFile } from '../object-storage.js';
import { stableOperationId, ToolError, type ToolContext } from '../tools.js';

export async function sendStoredFile(client: Client, context: ToolContext, file: StoredFile, bytes: Uint8Array): Promise<void> {
  await context.assertActive();
  const user = await client.users.fetch(context.message.author);
  const name = file.path.split('/').at(-1)!.replace(/[\\\u0000-\u001f\u007f]/g, '_');
  try {
    await user.send({
      content: `Your stored file: ${file.path}`,
      files: [{ attachment: Buffer.from(bytes), name }],
      allowedMentions: { parse: [] },
      nonce: stableOperationId(context.operationId, 'stored-file-dm'), enforceNonce: true,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 50007) throw new ToolError('Discord DMs are closed. Enable DMs or request a download link instead.', 'failed');
    throw error;
  }
}
