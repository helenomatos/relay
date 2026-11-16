function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  demo: {
    apiKey: process.env.DEMO_API_KEY,
    receiverSecret: process.env.RECEIVER_SECRET,
    // "url=type1,type2;url2=*"
    endpoints: process.env.DEMO_ENDPOINTS ?? "",
  },
};
