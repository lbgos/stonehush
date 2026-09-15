import {
  AdvisorTurnsRepository,
  EngagementRepository,
  EvidenceGrantRepository,
  ExcerptRepository,
  FfufRepository,
  HttpProbeRepository,
  NmapServiceRepository,
  OperatorCommandRepository,
  RunOutputRepository,
  RunRepository,
  RunnerRepository,
  SettingsRepository,
  openEngagementDatabase,
  type EngagementDatabase,
} from "@stonehush/db";
import { loadEvidenceNative } from "@stonehush/evidence-native";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import {
  bootstrapDevelopmentStorage,
  checkDevelopmentStorage,
} from "./development-storage.js";
import { BackupLock } from "./evidence/backup-lock.js";
import { EvidencePublicationService } from "./evidence/evidence-publication.js";
import { EvidenceStore } from "./evidence/evidence-store.js";
import { FfufProjectionService } from "./evidence/ffuf-projection.js";
import { HttpProbeProjectionService } from "./evidence/http-probe-projection.js";
import { NmapProjectionService } from "./evidence/nmap-projection.js";

interface RuntimeDependencies {
  bootstrapStorage?: typeof bootstrapDevelopmentStorage;
  createApp?: typeof buildApp;
  openDatabase?: typeof openEngagementDatabase;
}

export async function buildStorageBackedApp(
  dataDirectory: string,
  dependencies: RuntimeDependencies = {},
): Promise<FastifyInstance> {
  const bootstrapStorage =
    dependencies.bootstrapStorage ?? bootstrapDevelopmentStorage;
  const createApp = dependencies.createApp ?? buildApp;
  const openDatabase = dependencies.openDatabase ?? openEngagementDatabase;

  await bootstrapStorage(dataDirectory);
  const database = openDatabase({ dataDirectory });
  try {
    const engagementRepository = new EngagementRepository(database.db);
    const runRepository = new RunRepository(database.db);
    const runnerRepository = new RunnerRepository(database.db);
    const evidenceGrantRepository = new EvidenceGrantRepository(database.db);
    const nmapServiceRepository = new NmapServiceRepository(database.db);
    const httpProbeRepository = new HttpProbeRepository(database.db);
    const ffufRepository = new FfufRepository(database.db);
    const settingsRepository = new SettingsRepository(database.db);
    const advisorTurnsRepository = new AdvisorTurnsRepository(database.db);
    const runOutputRepository = new RunOutputRepository(database.db);
    const excerptRepository = new ExcerptRepository(database.db);

    // Evidence publication is fail-closed: without a loadable native binding
    // or valid managed evidence roots, the upload routes are not registered.
    let evidencePublication: EvidencePublicationService | undefined;
    let evidenceStore: EvidenceStore | undefined;
    let backupLock: BackupLock | undefined;
    const native = loadEvidenceNative();
    if (native.ok) {
      const storeResult = EvidenceStore.open(dataDirectory, native.binding);
      if (storeResult.ok) {
        const lockResult = BackupLock.open(dataDirectory, native.binding);
        if (!lockResult.ok) {
          storeResult.store.close();
          throw new Error("backup lockfile could not be established");
        }
        backupLock = lockResult.lock;
        const nmapProjection = new NmapProjectionService(storeResult.store, nmapServiceRepository);
        const httpProbeProjection = new HttpProbeProjectionService(storeResult.store, httpProbeRepository);
        const ffufProjection = new FfufProjectionService(storeResult.store, ffufRepository);
        evidencePublication = new EvidencePublicationService({
          repository: evidenceGrantRepository,
          store: storeResult.store,
          quiesceGate: backupLock,
          onPublicationCommitted: async (artifactId) => {
            const nmap = await nmapProjection.projectForArtifact(artifactId);
            if (!nmap.ok) return nmap;
            if (nmap.skipped !== true) return nmap;
            const probe = await httpProbeProjection.projectForArtifact(artifactId);
            if (!probe.ok) return probe;
            if (probe.skipped !== true) return probe;
            return ffufProjection.projectForArtifact(artifactId);
          },
        });
        evidenceStore = storeResult.store;
      }
    }

    const app = createApp({
      engagementRepository,
      operatorCommandRepository: new OperatorCommandRepository(
        engagementRepository,
      ),
      runRepository,
      runnerRepository,
      evidenceGrantRepository,
      ...(evidencePublication === undefined ? {} : { evidencePublication }),
      ...(evidenceStore === undefined ? {} : { evidenceStore }),
      ...(backupLock === undefined ? {} : { storageGate: backupLock }),
      nmapServiceRepository,
      settingsRepository,
      advisorTurnsRepository,
      httpProbeRepository,
      ffufRepository,
      runOutputRepository,
      excerptRepository,
      async getDevelopmentStorageReadiness() {
        await checkDevelopmentStorage(dataDirectory);
        return "ready" as const;
      },
    });
    if (evidenceStore !== undefined && backupLock !== undefined) {
      registerStoreClose(app, evidenceStore, backupLock);
    }
    registerDatabaseClose(app, database);
    return app;
  } catch (error) {
    database.close();
    throw error;
  }
}

function registerDatabaseClose(
  app: FastifyInstance,
  database: EngagementDatabase,
): void {
  let closed = false;
  app.addHook("onClose", async () => {
    if (closed) return;
    closed = true;
    database.close();
  });
}

function registerStoreClose(
  app: FastifyInstance,
  store: EvidenceStore,
  backupLock: BackupLock,
): void {
  let closed = false;
  app.addHook("onClose", async () => {
    if (closed) return;
    closed = true;
    backupLock.close();
    store.close();
  });
}
