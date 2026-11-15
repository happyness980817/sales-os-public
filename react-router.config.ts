import type { Config } from "@react-router/dev/config";

// Supply the same public URL during the build and at runtime behind a proxy.
const publicUrl = process.env.SALESOS_PUBLIC_URL || 'http://localhost:5173';

export default {
  ssr: true,
  allowedActionOrigins: [new URL(publicUrl).host],
} satisfies Config;
