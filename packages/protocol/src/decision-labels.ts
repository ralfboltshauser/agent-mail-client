import { z } from 'zod'

export const TAXONOMY_VERSION = 2
export const BucketDecisionLabel = z.enum([
  'bucket.reply',
  'bucket.action',
  'bucket.follow_up',
  'bucket.update',
  'bucket.later',
  'bucket.when_i_have_time',
  'bucket.newsletters',
  'bucket.clear',
])
export const CustomBucketId = z.templateLiteral(['bucket.custom.', z.uuid()])
export const BucketId = z.union([BucketDecisionLabel.exclude(['bucket.clear']), CustomBucketId])
export const FilterDecisionLabel = z.enum(['filter.filtered', 'filter.keep'])
export const SenderDecisionLabel = z.enum(['sender.accept', 'sender.block', 'sender.clear'])
export const AttentionDecisionLabel = z.enum(['attention.interrupt', 'attention.quiet'])
export const decisionLabels = {
  bucket: z.union([BucketDecisionLabel, CustomBucketId]),
  filter: FilterDecisionLabel,
  sender: SenderDecisionLabel,
  attention: AttentionDecisionLabel,
}
