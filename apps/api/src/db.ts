import postgres from "postgres";
import { config } from "./config";

export const sql = postgres(config.databaseUrl, {
  max: 20,
  transform: postgres.camel,
  onnotice: () => {},
});
