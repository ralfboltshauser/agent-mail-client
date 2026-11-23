const feedbackStages = [
  'CaptureUnavailable',
  'CaptureFailed',
  'InvalidSubmission',
  'LauncherUnavailable',
  'LaunchFailed',
  'OpenFailed',
] as const
export const clientEvents = {
  'feedback.launch.failed': { fields: { stage: feedbackStages } },
} as const
