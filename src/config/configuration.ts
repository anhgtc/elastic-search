function toInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export interface AppConfiguration {
  appMode: 'api' | 'worker' | 'reindex';
  http: { port: number; prefix: string };
  logLevel: string;
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    tablePrefix: string;
    connectionLimit: number;
  };
  elastic: {
    node: string;
    username: string;
    password: string;
    rejectUnauthorized: boolean;
    indexAlias: string;
  };
  redis: {
    host: string;
    port: number;
    password: string;
    db: number;
    keyPrefix: string;
  };
  ingest: {
    apiKey: string;
  };
  sync: {
    cron: string;
    batchSize: number;
    bootstrapReindex: boolean;
    enabled: boolean;
    depsEnabled: boolean;
  };
}

export default (): AppConfiguration => ({
  appMode: (process.env.APP_MODE as AppConfiguration['appMode']) || 'api',
  http: {
    port: toInt(process.env.HTTP_PORT, 3000),
    prefix: process.env.API_PREFIX || '',
  },
  logLevel: process.env.LOG_LEVEL || 'log',
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: toInt(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || '',
    tablePrefix: process.env.MYSQL_TABLE_PREFIX || '',
    connectionLimit: toInt(process.env.MYSQL_CONNECTION_LIMIT, 5),
  },
  elastic: {
    node: process.env.ELASTIC_NODE || 'http://localhost:9200',
    username: process.env.ELASTIC_USERNAME || '',
    password: process.env.ELASTIC_PASSWORD || '',
    rejectUnauthorized: toBool(process.env.ELASTIC_TLS_REJECT_UNAUTHORIZED, true),
    indexAlias: process.env.ELASTIC_INDEX_ALIAS || 'tvs_documents',
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: toInt(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || '',
    db: toInt(process.env.REDIS_DB, 0),
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'tvs_search:',
  },
  ingest: {
    apiKey: process.env.INGEST_API_KEY || '',
  },
  sync: {
    cron: process.env.SYNC_CRON || '*/1 * * * * *',
    batchSize: toInt(process.env.SYNC_BATCH_SIZE, 1000),
    bootstrapReindex: toBool(process.env.SYNC_BOOTSTRAP_REINDEX, true),
    enabled: toBool(process.env.SYNC_ENABLED, true),
    depsEnabled: toBool(process.env.SYNC_DEPS_ENABLED, true),
  },
});
