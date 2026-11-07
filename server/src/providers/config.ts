export type ProviderConfig = {
  diditKey: string;
  diditWorkflowId: string;
  diditWebhookSecret: string;
  rangeApiKey: string | null;
};

const REQUIRED = [
  "DIDIT_API_KEY",
  "DIDIT_WORKFLOW_ID",
  "DIDIT_WEBHOOK_SECRET",
] as const;

export function assertProviderConfig(env: NodeJS.ProcessEnv): ProviderConfig {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    const error = new Error("MISSING_PROVIDER_CONFIG");
    (error as Error & { missing: string[] }).missing = missing;
    throw error;
  }
  return {
    diditKey: env.DIDIT_API_KEY as string,
    diditWorkflowId: env.DIDIT_WORKFLOW_ID as string,
    diditWebhookSecret: env.DIDIT_WEBHOOK_SECRET as string,
    rangeApiKey: env.RANGE_API_KEY ? env.RANGE_API_KEY : null,
  };
}
