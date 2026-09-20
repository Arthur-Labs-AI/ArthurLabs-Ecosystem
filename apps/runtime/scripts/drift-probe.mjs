import { SentryDatabase, SentryRepository } from '/home/merte/.local/share/sentry/runtime/current/packages/persistence/dist/index.js';
const db = new SentryDatabase({ dataRoot: '/home/merte/.local/share/sentry-live' });
const repo = new SentryRepository(db);
for (const p of repo.listProjects()) {
  const copy = repo.getManagedCopy(p.id);
  const revs = repo.listRevisions(p.id);
  console.log('PROJECT:' + p.id + ' name=' + p.name + ' src=' + p.sourcePath + ' state=' + (copy && copy.state) + ' revs=' + revs.length);
  const cur = revs.find((r) => copy && r.id === copy.currentRevisionId);
  console.log('CURRENT_REV:' + (cur && cur.id) + ' hash=' + (cur && cur.contentHash) + ' files=' + (cur && cur.stats.fileCount) + ' bytes=' + (cur && cur.stats.totalBytes));
}
db.close();
