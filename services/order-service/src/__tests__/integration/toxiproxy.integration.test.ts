/**
 * Network fault injection with Toxiproxy on real infrastructure.
 *
 * Toxiproxy sits between the client and a real Postgres. Disabling the proxy
 * simulates a network partition; a query fails while partitioned and succeeds
 * again once the partition heals. This is the network-level fault the plan
 * assigns to Toxiproxy (the application-level duplicate/reorder/crash faults are
 * exercised by the chaos runner and the Kafka test).
 *
 * SKIPPED in this environment: the modern Toxiproxy image
 * (ghcr.io/shopify/toxiproxy) is not pullable from the sandbox's registry, and
 * the only Docker Hub tag available (shopify/toxiproxy:2.1.0) is an amd64-only
 * binary that fails to start under the local ARM Docker (colima) emulation
 * ("runtime: failed to create new OS thread"). The test is written to run
 * unchanged where ghcr.io is reachable; enable it by removing `.skip`.
 */
import { GenericContainer, Network, StartedNetwork, StartedTestContainer, Wait } from 'testcontainers';
import { Toxiproxy } from 'toxiproxy-node-client';
import { Client } from 'pg';

describe.skip('network partition via Toxiproxy', () => {
  let network: StartedNetwork;
  let pg: StartedTestContainer;
  let toxi: StartedTestContainer;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let proxy: any;
  let proxyHost: string;
  let proxyPort: number;

  const USER = 'orderflow';
  const PASSWORD = 'orderflow123';
  const DBNAME = 'orderdb';

  async function queryThroughProxy(): Promise<number> {
    const client = new Client({
      host: proxyHost,
      port: proxyPort,
      user: USER,
      password: PASSWORD,
      database: DBNAME,
      connectionTimeoutMillis: 3000,
    });
    await client.connect();
    const res = await client.query('SELECT 1 AS ok');
    await client.end();
    return res.rows[0].ok;
  }

  beforeAll(async () => {
    network = await new Network().start();
    pg = await new GenericContainer('postgres:15-alpine')
      .withNetwork(network)
      .withNetworkAliases('pg-db')
      .withEnvironment({ POSTGRES_USER: USER, POSTGRES_PASSWORD: PASSWORD, POSTGRES_DB: DBNAME })
      .withExposedPorts(5432)
      .start();

    toxi = await new GenericContainer('ghcr.io/shopify/toxiproxy:2.11.0')
      .withNetwork(network)
      .withExposedPorts(8474, 8666)
      .withWaitStrategy(Wait.forHttp('/version', 8474))
      .start();

    const client = new Toxiproxy(`http://${toxi.getHost()}:${toxi.getMappedPort(8474)}`);
    proxy = await client.createProxy({ name: 'pg', listen: '0.0.0.0:8666', upstream: 'pg-db:5432' });
    proxyHost = toxi.getHost();
    proxyPort = toxi.getMappedPort(8666);
    await new Promise((r) => setTimeout(r, 1500));
  }, 240000);

  afterAll(async () => {
    await toxi?.stop();
    await pg?.stop();
    await network?.stop();
  });

  it('a query succeeds, fails under a partition, and recovers when healed', async () => {
    expect(await queryThroughProxy()).toBe(1);

    proxy = await proxy.update({ enabled: false, listen: proxy.listen, upstream: proxy.upstream });
    await expect(queryThroughProxy()).rejects.toBeDefined();

    proxy = await proxy.update({ enabled: true, listen: proxy.listen, upstream: proxy.upstream });
    expect(await queryThroughProxy()).toBe(1);
  }, 60000);
});
