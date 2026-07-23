import { Pool } from "pg";
import { dbConfig } from "../config/env";

/** Shared PostgreSQL connection pool — imported by every repository. */
export const pool = new Pool(dbConfig);
