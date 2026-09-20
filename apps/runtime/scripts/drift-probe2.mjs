import { SentryDatabase, SentryRepository } from '/home/merte/.local/share/sentry/runtime/current/packages/persistence/dist/index.js';
const db = new SentryDatabase({ dataRoot: '/home/merte/.local/share/sentry' });
const repo = new SentryRepository(db);
for (const p of repo.listProjects()) {
  const copy = repo.getManagedCopy(p.id);
  const revs = repo.listRevisions(p.id);
  const cur = revs.find((r) => copy && r.id === copy.currentRevisionId);
  console.log('PROJECT:' + p.id + ' name=' + p.name + ' state=' + (copy && copy.state));
  console.log('  src=' + p.sourcePath);
  console.log('  revs=' + revs.length + ' cur=' + (cur && cur.id) + ' files=' + (cur && cur.stats.fileCount) + ' bytes=' + (cur && cur.stats.totalBytes));
}
console.log('OPS:' + JSON.stringify(repo.listRuntimeOperations().map((o) => ({ type: o.type, stage: o.stage, project: o.projectId }))));
db.close();
