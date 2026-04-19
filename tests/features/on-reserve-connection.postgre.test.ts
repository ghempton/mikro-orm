import { defineEntity, MikroORM, p } from '@mikro-orm/postgresql';

// Minimal entity used to exercise pooled connection acquisition.
const Foo = defineEntity({
  name: 'OnReserveConnectionFoo',
  tableName: 'on_reserve_connection_foo',
  properties: {
    id: p.integer().primary().autoincrement(),
    name: p.string(),
  },
});

describe('onReserveConnection hook (postgres)', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) {
      await orm.schema.dropDatabase();
      await orm.close(true);
    }
  });

  test('fires on every pool acquire and is awaited before the connection is used', async () => {
    const reserveCalls: number[] = [];
    let lastSeenTenantId: string | null = null;

    orm = await MikroORM.init({
      entities: [Foo],
      dbName: `mikro_orm_test_${(Math.random() + 1).toString(36).substring(2)}`,
      logger: () => undefined,
      onReserveConnection: async connection => {
        reserveCalls.push(Date.now());
        await (connection as any).executeQuery({
          sql: `SET app.tenant_id = 'tenant-${reserveCalls.length}'`,
          parameters: [],
          query: {},
          queryId: { queryId: 'rls-set' },
        });
      },
    });

    await orm.schema.refresh();

    // Every acquire should have fired the hook at least once by now.
    const baseline = reserveCalls.length;
    expect(baseline).toBeGreaterThan(0);

    // An explicit read on a fresh EntityManager forks acquires a new connection.
    // The SET inside the hook is visible to the subsequent query on the same connection.
    const em = orm.em.fork();
    const result = await em
      .getConnection()
      .execute<{ tenant: string }[]>(`SELECT current_setting('app.tenant_id', true) AS tenant`);
    expect(result[0].tenant).toMatch(/^tenant-\d+$/);
    lastSeenTenantId = result[0].tenant;

    // A subsequent query may reuse the same pooled connection (still tenant-X)
    // or acquire a new one (tenant-Y). Either way the hook ran and the SET was
    // applied on whatever connection we got.
    const before = reserveCalls.length;
    const result2 = await em
      .getConnection()
      .execute<{ tenant: string }[]>(`SELECT current_setting('app.tenant_id', true) AS tenant`);
    expect(reserveCalls.length).toBeGreaterThan(before);
    expect(result2[0].tenant).toMatch(/^tenant-\d+$/);

    // Different acquires should produce different tenant ids because the hook
    // increments `reserveCalls.length` before running the SET.
    expect(reserveCalls.length).toBeGreaterThan(1);
    expect(lastSeenTenantId).not.toBeNull();
  });

  test('inside a transaction the hook fires once for the pinned connection', async () => {
    let reserveCount = 0;

    orm = await MikroORM.init({
      entities: [Foo],
      dbName: `mikro_orm_test_${(Math.random() + 1).toString(36).substring(2)}`,
      logger: () => undefined,
      onReserveConnection: async () => {
        reserveCount++;
      },
    });

    await orm.schema.refresh();
    const baseline = reserveCount;

    await orm.em.transactional(async em => {
      // Three queries inside a single transaction share one pinned connection,
      // so the hook fires exactly once for the transaction's acquire.
      const conn = em.getConnection();
      await conn.execute('SELECT 1', [], 'all', em.getTransactionContext());
      await conn.execute('SELECT 2', [], 'all', em.getTransactionContext());
      await conn.execute('SELECT 3', [], 'all', em.getTransactionContext());
    });

    expect(reserveCount - baseline).toBe(1);
  });

  test('omitting the hook preserves existing behavior', async () => {
    orm = await MikroORM.init({
      entities: [Foo],
      dbName: `mikro_orm_test_${(Math.random() + 1).toString(36).substring(2)}`,
      logger: () => undefined,
    });

    await orm.schema.refresh();
    const result = await orm.em.getConnection().execute<{ one: number }[]>(`SELECT 1 AS one`);
    expect(result[0].one).toBe(1);
  });
});
