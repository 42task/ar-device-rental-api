import type { Request, Response } from 'express';
import type { Database } from './database';

export type Row = Record<string, any>;
export interface Context {
  req: Request & { rawBody?: Buffer };
  res: Response;
  body: Row;
  query: Row;
  params: Record<string, string>;
}
export interface Services { db: Database }
export type Handler = (context: Context) => unknown | Promise<unknown>;
export interface Route { method: string; path: string; handler: Handler }
