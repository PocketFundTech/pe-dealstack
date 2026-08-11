import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';

interface CreateSignalNotificationInput {
  dealId: string;
  signalType: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  suggestedAction: string;
}

export async function createSignalNotification(
  _organizationId: string,
  input: CreateSignalNotificationInput,
): Promise<{ created: boolean }> {
  if (!input.dealId || (input.severity !== 'critical' && input.severity !== 'warning')) {
    return { created: false };
  }

  const { error } = await supabase.from('Activity').insert({
    dealId: input.dealId,
    type: 'AI_SIGNAL',
    title: `[${input.severity.toUpperCase()}] ${input.title}`,
    description: `${input.description}. Suggested action: ${input.suggestedAction}`,
  });

  if (error) {
    log.error('create_signal_notification: failed to persist', { dealId: input.dealId, error: error.message });
    return { created: false };
  }
  return { created: true };
}
