import { describe, expect, it } from 'vitest';
import {
  QA_ANTI_SUPERFICIAL_RULES,
  QA_AUTHORITY_HIERARCHY,
  QA_INVESTIGATION_METHOD,
  QA_INVESTIGATION_REPRODUCTION_GUIDANCE,
  QA_LARGE_PROJECT_GUIDANCE,
  QA_PLANNING_RISK_GUIDANCE,
  QA_REPORTING_COVERAGE_GUIDANCE,
  REPORT_CONFIDENCE_CALIBRATION,
  REPORT_LEDGER_RULES,
  REPORT_REPRODUCTION_CONTRACT,
} from '../src/index.js';

describe('shared QA prompt guidance', () => {
  it('keeps the shared reporting contracts intact', () => {
    expect(REPORT_REPRODUCTION_CONTRACT).toContain('operation key');
    expect(REPORT_REPRODUCTION_CONTRACT).toContain('NOT behavior reproduction');
    expect(REPORT_LEDGER_RULES).toContain('ONLY authoritative source');
    expect(REPORT_CONFIDENCE_CALIBRATION).toContain('confirmed requires');
  });

  it('establishes the instruction authority hierarchy with injection handling', () => {
    expect(QA_AUTHORITY_HIERARCHY).toContain('Authority hierarchy');
    expect(QA_AUTHORITY_HIERARCHY).toContain('UNTRUSTED');
    expect(QA_AUTHORITY_HIERARCHY).toContain('ignore the instruction');
    expect(QA_AUTHORITY_HIERARCHY).toContain('hypothesis to validate');
  });

  it('requires risk-based bounded planning without schema changes', () => {
    expect(QA_PLANNING_RISK_GUIDANCE).toContain('risk-first');
    expect(QA_PLANNING_RISK_GUIDANCE).toContain('user-facing workflows');
    expect(QA_PLANNING_RISK_GUIDANCE).toContain('auth');
    expect(QA_PLANNING_RISK_GUIDANCE).toContain('Prioritize checks by');
    expect(QA_PLANNING_RISK_GUIDANCE).toContain('do not inventory every file');
    // Must fit inside existing V1 fields; never demand new schema fields.
    expect(QA_PLANNING_RISK_GUIDANCE).not.toMatch(/schemaVersion.*3/i);
  });

  it('defines the adaptive investigation methodology', () => {
    expect(QA_INVESTIGATION_METHOD).toContain('Phase A');
    expect(QA_INVESTIGATION_METHOD).toContain('Phase B');
    expect(QA_INVESTIGATION_METHOD).toContain('Phase C');
    expect(QA_INVESTIGATION_METHOD).toContain('Phase D');
    expect(QA_INVESTIGATION_METHOD).toContain('Phase E');
    expect(QA_INVESTIGATION_METHOD).toContain('Phase F');
    expect(QA_INVESTIGATION_METHOD).toContain('honest coverage');
    // A clean investigation must never be presented as proof the software
    // is bug-free. Guard the intent without contradicting the required
    // positive phrasing below (which itself contains 'bug-free').
    expect(QA_INVESTIGATION_METHOD).not.toContain('proves the software is bug-free');
    expect(QA_INVESTIGATION_METHOD).not.toContain('guarantees no defects');
    expect(QA_INVESTIGATION_METHOD).toContain('never means the software is bug-free');
    expect(QA_INVESTIGATION_METHOD).toContain('never presented as complete');
  });

  it('discourages superficial QA without demanding silence', () => {
    expect(QA_ANTI_SUPERFICIAL_RULES).toContain('successful build as proof');
    expect(QA_ANTI_SUPERFICIAL_RULES).toContain('passing tests as proof');
    expect(QA_ANTI_SUPERFICIAL_RULES).toContain('no failure');
    expect(QA_ANTI_SUPERFICIAL_RULES).toContain('still reportable');
  });

  it('scales to large projects without fixed caps', () => {
    expect(QA_LARGE_PROJECT_GUIDANCE).toContain('call-path tracing');
    expect(QA_LARGE_PROJECT_GUIDANCE.length).toBeGreaterThan(100);
    expect(QA_LARGE_PROJECT_GUIDANCE).toContain('no fixed caps');
    expect(QA_LARGE_PROJECT_GUIDANCE).toContain('honestly');
  });

  it('keeps investigation reproduction distinct from exploration', () => {
    expect(QA_INVESTIGATION_REPRODUCTION_GUIDANCE).toContain('narrow focused reproduction');
    expect(QA_INVESTIGATION_REPRODUCTION_GUIDANCE).toContain('NOT behavior reproduction');
    expect(QA_INVESTIGATION_REPRODUCTION_GUIDANCE).toContain('frozen ledger');
    expect(QA_INVESTIGATION_REPRODUCTION_GUIDANCE).toContain('Never modify the original');
  });

  it('requires honest reporting coverage with no finding quotas', () => {
    expect(QA_REPORTING_COVERAGE_GUIDANCE).toContain('honestly');
    expect(QA_REPORTING_COVERAGE_GUIDANCE).toContain('not_run');
    expect(QA_REPORTING_COVERAGE_GUIDANCE).toContain('never');
    expect(QA_REPORTING_COVERAGE_GUIDANCE).toContain('zero findings');
    expect(QA_REPORTING_COVERAGE_GUIDANCE).toContain('defect-free');
  });
});
