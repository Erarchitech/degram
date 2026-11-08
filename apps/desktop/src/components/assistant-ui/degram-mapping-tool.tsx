import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { FC } from 'react'

import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { mappingCardAnchor, MappingChatCard } from '@/degram/mapping-chat-card'

/** `degram_mapping` (DeGram, DG 1303-33): the mapping card once the result names a session; anything else (still
 *  running, a refusal, a sessions list) stays the normal tool row. */
export const DegramMappingTool: FC<ToolCallMessagePartProps> = props => {
  const anchor = mappingCardAnchor(props.result)

  return anchor ? <MappingChatCard anchor={anchor} /> : <ToolFallback {...props} />
}
