/** Frozen, outcome-blind screening candidates for the approved CQ comparison.
 *
 * This is an inventory of planned cells, not evidence that a cell ran or won.
 * Numeric budgets and evaluation-boundary hashes are supplied by calibration
 * and the parent campaign manifest; this module does not infer pilot results.
 */
import { createHash } from 'node:crypto';
import {
  defineBudgetTiers,
  type EvaluationTrack,
  type PerTaskBudgetTier,
  type StrategyRecipe,
  type StrategyRoute,
} from './index.ts';

export const SCREENING_PROFILE_EVIDENCE = Object.freeze({
  capturedAtUTC: '2026-09-28T21:58:19Z',
  sources: Object.freeze(['Paseo list_profiles', 'Paseo list_models', 'Paseo inspect_provider']),
  codex: Object.freeze({
    provider: 'codex',
    modes: Object.freeze(['auto', 'auto-review', 'full-access']),
    sol: Object.freeze({
      profileName: 'GPT-6 Sol', model: 'gpt-6-sol', configuredMode: 'full-access',
      configuredEffort: 'low', supportedEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      defaultEffort: 'low',
    }),
    luna: Object.freeze({
      profileName: null, profileStatus: 'configured-provider-model-no-named-profile',
      model: 'gpt-6-luna', configuredMode: 'full-access', configuredEffort: 'high',
      supportedEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']), defaultEffort: 'high',
    }),
  }),
  glmFlash: Object.freeze({
    provider: 'zcode', profileName: 'GLM-5.3-Flash', model: 'GLM-5.3-Flash',
    configuredMode: 'yolo', configuredEffort: 'high',
    supportedEfforts: Object.freeze(['low', 'high', 'max']), defaultEffort: 'high',
  }),
  spaceBunny: Object.freeze({
    provider: 'pi-opencode', profileName: 'Space Bunny Free (Pi OpenCode)',
    configuredModel: 'opencode-go/space-bunny-free', underlyingModel: 'anonymous',
    configuredEffort: 'high', effortStatus: 'profile-requested; model capability not exposed',
  }),
  interpretation: 'Profile/model inventory only; requested values do not prove effective runtime settings or transport conformance.',
});

export type CandidateAvailability = 'planned' | 'unsupported' | 'unscreened';
export type ScreeningTrack = EvaluationTrack;

export interface ScreeningProfile {
  readonly id: 'codex-sol' | 'codex-luna' | 'zcode-glm-flash' | 'pi-space-bunny';
  readonly displayName: string;
  readonly provider: string;
  readonly configuredProfile: string | null;
  readonly configuredModel: string;
  readonly underlyingModel: string | 'anonymous';
  readonly nativeTransport: StrategyRoute['transport'];
  readonly configuredMode: string | null;
  readonly requestedProfileEffort: string;
  readonly supportedEfforts: readonly string[];
  readonly effortEvidence: 'provider-model-inventory' | 'profile-request-only';
  readonly profileInventoryEvidence: string;
}

export const SCREENING_PROFILES: readonly ScreeningProfile[] = Object.freeze([
  Object.freeze({
    id: 'codex-sol', displayName: 'GPT-6 Sol', provider: 'codex', configuredProfile: 'GPT-6 Sol',
    configuredModel: 'gpt-6-sol', underlyingModel: 'gpt-6-sol', nativeTransport: 'codex-exec',
    configuredMode: 'full-access', requestedProfileEffort: 'low',
    supportedEfforts: SCREENING_PROFILE_EVIDENCE.codex.sol.supportedEfforts,
    effortEvidence: 'provider-model-inventory', profileInventoryEvidence: 'Paseo profile GPT-6 Sol',
  }),
  Object.freeze({
    id: 'codex-luna', displayName: 'GPT-6 Luna', provider: 'codex', configuredProfile: null,
    configuredModel: 'gpt-6-luna', underlyingModel: 'gpt-6-luna', nativeTransport: 'codex-exec',
    configuredMode: 'full-access', requestedProfileEffort: 'high',
    supportedEfforts: SCREENING_PROFILE_EVIDENCE.codex.luna.supportedEfforts,
    effortEvidence: 'provider-model-inventory', profileInventoryEvidence: 'Paseo Codex provider model gpt-6-luna; no named Luna profile',
  }),
  Object.freeze({
    id: 'zcode-glm-flash', displayName: 'GLM-5.3-Flash', provider: 'zcode', configuredProfile: 'GLM-5.3-Flash',
    configuredModel: 'GLM-5.3-Flash', underlyingModel: 'GLM-5.3-Flash', nativeTransport: 'zcode-acp',
    configuredMode: 'yolo', requestedProfileEffort: 'high',
    supportedEfforts: SCREENING_PROFILE_EVIDENCE.glmFlash.supportedEfforts,
    effortEvidence: 'provider-model-inventory', profileInventoryEvidence: 'Paseo profile GLM-5.3-Flash',
  }),
  Object.freeze({
    id: 'pi-space-bunny', displayName: 'Space Bunny', provider: 'pi-opencode',
    configuredProfile: 'Space Bunny Free (Pi OpenCode)', configuredModel: 'opencode-go/space-bunny-free',
    underlyingModel: 'anonymous', nativeTransport: 'pi-json', configuredMode: null,
    requestedProfileEffort: 'high', supportedEfforts: Object.freeze([]), effortEvidence: 'profile-request-only',
    profileInventoryEvidence: 'Paseo profile and configured model; underlying model remains anonymous',
  }),
]);

export type ScreeningBudgetTier = PerTaskBudgetTier;

export interface ScreeningCatalogInputs {
  /** Pilot-derived values are required; catalog defaults would imply unsupported evidence. */
  readonly budgetTiers: readonly ScreeningBudgetTier[];
  readonly boundaryHashes: Readonly<Record<ScreeningTrack, string>>;
  readonly toolsAssistanceHashes: Readonly<Record<ScreeningTrack, string>>;
  readonly sourcePin: string;
  readonly corpusPin: string;
  readonly judgePin: string;
  readonly profileEvidenceHash?: string;
}

export interface ChargedStageEnvelope {
  /** Maximum strategy invocations, including draft, verifier, repair, selection, escalation and oracle. */
  readonly chargedAttempts: number;
  /** Maximum strategy stages, including independent final judge. */
  readonly chargedStages: number;
  readonly modelOrScaffoldStages: number;
  readonly finalJudgeStages: 1;
  readonly tierAttemptCap: number;
  readonly tierStageCap: number;
  readonly attemptLimitDisposition: 'fits' | 'bounded-truncation-possible';
  readonly stageLimitDisposition: 'fits' | 'bounded-truncation-possible';
  readonly sharedCumulativeWallMs: number;
  readonly candidateWorkWallMs: number;
  readonly shutdownReserveMs: number;
  readonly observationReserveMs: number;
  readonly captureReserveMs: number;
  readonly independentJudgeReserveMs: number;
  readonly tokenBudget: number | null;
  readonly tokenCapClaim: 'none';
}

export interface ScreeningCandidate {
  readonly candidateId: string;
  /** Stable ID binds profile, track, boundaries, assistance, recipe and every budget tier field. */
  readonly strategyId: string;
  readonly track: ScreeningTrack;
  readonly status: CandidateAvailability;
  readonly statusReason: string;
  readonly plannedCandidateOnly: true;
  readonly profileIds: readonly ScreeningProfile['id'][];
  readonly participantModels: readonly string[];
  readonly underlyingIdentity: readonly string[];
  readonly selectedEfforts: readonly (string | null)[];
  readonly effortSupport: readonly ('supported' | 'profile-request-only')[];
  readonly boundaryHash: string;
  readonly toolsAssistanceHash: string;
  readonly recipe: StrategyRecipe;
  readonly recipeId: StrategyRecipe['kind'];
  readonly budgetTier: ScreeningBudgetTier;
  readonly stageBudgetPolicy: 'one-cumulative-pipeline-cap-with-separate-reserves';
  readonly chargedStageEnvelope: ChargedStageEnvelope;
  readonly identityHash: string;
}

export interface UnsupportedScreeningSetting {
  readonly profileId: ScreeningProfile['id'];
  readonly setting: 'effort';
  readonly value: string;
  readonly status: 'unsupported' | 'not-exposed';
  readonly reason: string;
}

export interface ScreeningCatalog {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly generatedFromEvidenceAtUTC: string;
  readonly evidence: typeof SCREENING_PROFILE_EVIDENCE;
  readonly supportedSettings: readonly {
    profileId: ScreeningProfile['id'];
    provider: string;
    configuredModel: string;
    underlyingModel: string | 'anonymous';
    availableEfforts: readonly string[];
    profileRequestedEffort: string;
    effortEvidence: ScreeningProfile['effortEvidence'];
    modes: readonly string[];
    tokenEnforcement: 'unsupported';
  }[];
  readonly unsupportedSettings: readonly UnsupportedScreeningSetting[];
  readonly candidates: readonly ScreeningCandidate[];
  readonly candidateCount: number;
  readonly trackCandidateCounts: Readonly<Record<ScreeningTrack, number>>;
}

const ROLE_EFFORT_FAMILY = new Map<string, string>([
  ['codex-sol', 'high'], ['codex-luna', 'high'], ['zcode-glm-flash', 'high'], ['pi-space-bunny', 'high'],
]);

/** Generate a deliberately small, staged covering design (not a Cartesian sweep). */
export function createScreeningCatalog(inputs: ScreeningCatalogInputs): ScreeningCatalog {
  const tiers = defineBudgetTiers(inputs.budgetTiers);
  assertHash(inputs.boundaryHashes.native, 'native boundary hash');
  assertHash(inputs.boundaryHashes.diagnostic, 'diagnostic boundary hash');
  assertHash(inputs.toolsAssistanceHashes.native, 'native tools/assistance hash');
  assertHash(inputs.toolsAssistanceHashes.diagnostic, 'diagnostic tools/assistance hash');
  if (!inputs.sourcePin || !inputs.corpusPin || !inputs.judgePin) throw new Error('Screening catalog requires source, corpus and judge pins');
  for (const tier of tiers) {
    if (tier.tokenBudget !== undefined) throw new Error(`Screening routes have no verified hard token caps; ${tier.id} must not claim one`);
    if (tier.tokenPolicy === 'hard-required') throw new Error(`Screening routes cannot satisfy hard-required token enforcement: ${tier.id}`);
  }
  const evidenceHash = inputs.profileEvidenceHash ?? sha256(canonical(SCREENING_PROFILE_EVIDENCE));
  const candidateById = new Map<string, ScreeningCandidate>();
  const candidateIdentityById = new Map<string, string>();

  const add = (track: ScreeningTrack, profiles: readonly ScreeningProfile[], recipe: StrategyRecipe, efforts: readonly (string | null)[]): void => {
    const tierIds = tiers.map((tier) => tier.id);
    const boundaryHash = inputs.boundaryHashes[track];
    const toolsAssistanceHash = inputs.toolsAssistanceHashes[track];
    for (const tier of tiers) {
      const chargedStageEnvelope = stageEnvelope(recipe, tier);
      const identity = {
        version: 1, track, profileIds: profiles.map((profile) => profile.id),
        profiles: profiles.map((profile) => ({ profile, selectedEffort: efforts[profiles.indexOf(profile)] ?? null })),
        boundaryHash, toolsAssistanceHash, evidenceHash, sourcePin: inputs.sourcePin, corpusPin: inputs.corpusPin,
        judgePin: inputs.judgePin, recipe, tier, tierIds, chargedStageEnvelope,
      };
      const identityHash = sha256(canonical(identity));
      const strategyId = `strategy-${identityHash.slice(0, 28)}`;
      const candidateId = `screen-${sha256(`${track}\0${identityHash}`).slice(0, 28)}`;
      const serializedIdentity = canonical(identity);
      const previousIdentity = candidateIdentityById.get(candidateId);
      if (previousIdentity && previousIdentity !== serializedIdentity) throw new Error(`Screening candidate ID collision: ${candidateId}`);
      if (candidateById.has(candidateId)) throw new Error(`Duplicate screening candidate identity: ${candidateId}`);
      candidateIdentityById.set(candidateId, serializedIdentity);
      const immutableRecipe = deepFreeze(structuredClone(recipe));
      candidateById.set(candidateId, Object.freeze({
        candidateId, strategyId, track, status: 'planned', statusReason: 'planned screening cell; no outcome evidence exists',
        plannedCandidateOnly: true, profileIds: Object.freeze(profiles.map((profile) => profile.id)),
        participantModels: Object.freeze(profiles.map((profile) => profile.configuredModel)),
        underlyingIdentity: Object.freeze(profiles.map((profile) => profile.underlyingModel)),
        selectedEfforts: Object.freeze([...efforts]),
        effortSupport: Object.freeze(profiles.map((profile) => profile.effortEvidence === 'profile-request-only' ? 'profile-request-only' : 'supported')),
        boundaryHash, toolsAssistanceHash, recipe: immutableRecipe, recipeId: recipe.kind, budgetTier: tier,
        stageBudgetPolicy: 'one-cumulative-pipeline-cap-with-separate-reserves', chargedStageEnvelope, identityHash,
      }));
    }
  };

  const nativeRoute = (profile: ScreeningProfile, effort: string | null): StrategyRoute => ({
    id: routeId('native', profile, effort), transport: profile.nativeTransport,
    tokenEnforcement: 'unsupported', supportedSettings: { effort: profile.supportedEfforts },
    ...(effort === null ? {} : { selectedEffort: effort }),
  });
  const diagnosticRoute = (profile: ScreeningProfile, effort: string | null): StrategyRoute => ({
    id: routeId('diagnostic', profile, effort), transport: 'shared-diagnostic',
    tokenEnforcement: 'unsupported', supportedSettings: { effort: profile.supportedEfforts },
    ...(effort === null ? {} : { selectedEffort: effort }),
  });
  const defaultEffort = (profile: ScreeningProfile): string | null =>
    profile.effortEvidence === 'provider-model-inventory' ? ROLE_EFFORT_FAMILY.get(profile.id) ?? profile.requestedProfileEffort : null;
  const nativeProfiles = SCREENING_PROFILES;

  // Full supported-effort coverage uses the inexpensive baseline recipe at all tiers.
  for (const profile of nativeProfiles) {
    const efforts: readonly (string | null)[] = profile.supportedEfforts.length > 0 ? profile.supportedEfforts : [null];
    for (const effort of efforts) add('native', [profile], { kind: 'one-shot', route: nativeRoute(profile, effort) }, [effort]);
  }

  // One representative profile effort carries each scaffold family across every tier.
  for (const profile of nativeProfiles) {
    const effort = defaultEffort(profile);
    const route = nativeRoute(profile, effort);
    add('native', [profile], { kind: 'same-model-verify-repair', route, maxRepairs: 1 }, [effort]);
    add('native', [profile], { kind: 'candidate-selection', route, candidateCount: 2, selector: { kind: 'frozen-rule' } }, [effort]);
  }

  // Directed mixed-model examples cover both drafting and verification roles without every permutation.
  for (const [draftId, verifyId] of [
    ['codex-luna', 'zcode-glm-flash'], ['zcode-glm-flash', 'codex-luna'],
    ['codex-sol', 'pi-space-bunny'], ['pi-space-bunny', 'codex-sol'],
  ] as const) {
    const draft = profileById(draftId), verify = profileById(verifyId);
    const draftEffort = defaultEffort(draft), verifyEffort = defaultEffort(verify);
    add('native', [draft, verify], {
      kind: 'mixed-model-verify-repair', draftRoute: nativeRoute(draft, draftEffort),
      verifyRoute: nativeRoute(verify, verifyEffort), repairRoute: nativeRoute(draft, draftEffort), maxRepairs: 1,
    }, [draftEffort, verifyEffort]);
  }

  // Escalate low-to-high only where both effort levels are present in the live capability inventory.
  for (const profile of nativeProfiles.filter((item) => item.supportedEfforts.includes('low') && item.supportedEfforts.includes('high'))) {
    add('native', [profile], {
      kind: 'cheap-first-escalation',
      tiers: [{ route: nativeRoute(profile, 'low'), effort: 'low' }, { route: nativeRoute(profile, 'high'), effort: 'high' }],
      promoteWhen: 'verification-failed',
    }, ['low', 'high']);
  }

  // Separate diagnostic family: compact representatives of each approved recipe.
  // Shared routes are planned identities, not claims that a common harness is already conformant.
  const diagnosticDefault = nativeProfiles.map((profile) => ({ profile, effort: defaultEffort(profile) }));
  for (const { profile, effort } of diagnosticDefault) {
    add('diagnostic', [profile], { kind: 'one-shot', route: diagnosticRoute(profile, effort) }, [effort]);
  }
  const luna = profileById('codex-luna'), glm = profileById('zcode-glm-flash');
  const lunaEffort = defaultEffort(luna), glmEffort = defaultEffort(glm);
  add('diagnostic', [luna], { kind: 'same-model-verify-repair', route: diagnosticRoute(luna, lunaEffort), maxRepairs: 1 }, [lunaEffort]);
  add('diagnostic', [glm], { kind: 'candidate-selection', route: diagnosticRoute(glm, glmEffort), candidateCount: 2, selector: { kind: 'frozen-rule' } }, [glmEffort]);
  add('diagnostic', [luna, glm], {
    kind: 'mixed-model-verify-repair', draftRoute: diagnosticRoute(luna, lunaEffort),
    verifyRoute: diagnosticRoute(glm, glmEffort), repairRoute: diagnosticRoute(luna, lunaEffort), maxRepairs: 1,
  }, [lunaEffort, glmEffort]);
  add('diagnostic', [luna], {
    kind: 'cheap-first-escalation', tiers: [
      { route: diagnosticRoute(luna, 'low'), effort: 'low' }, { route: diagnosticRoute(luna, 'high'), effort: 'high' },
    ], promoteWhen: 'verification-failed',
  }, ['low', 'high']);

  const candidates = [...candidateById.values()];
  const catalogBody = {
    schemaVersion: 1 as const, generatedFromEvidenceAtUTC: SCREENING_PROFILE_EVIDENCE.capturedAtUTC,
    evidenceHash, inputs: { ...inputs, budgetTiers: tiers }, candidates: candidates.map((candidate) => candidate.identityHash),
  };
  const catalogId = `catalog-${sha256(canonical(catalogBody)).slice(0, 28)}`;
  const unsupportedSettings: UnsupportedScreeningSetting[] = [
    ...SCREENING_PROFILES.flatMap((profile) => profile.effortEvidence === 'profile-request-only'
      ? [{ profileId: profile.id, setting: 'effort' as const, value: profile.requestedProfileEffort,
        status: 'not-exposed' as const, reason: 'configured profile requests this effort, but model capability inventory exposes no supported effort list' }]
      : []),
  ];
  return Object.freeze({
    schemaVersion: 1, catalogId, generatedFromEvidenceAtUTC: SCREENING_PROFILE_EVIDENCE.capturedAtUTC,
    evidence: SCREENING_PROFILE_EVIDENCE,
    supportedSettings: Object.freeze(SCREENING_PROFILES.map((profile) => Object.freeze({
      profileId: profile.id, provider: profile.provider, configuredModel: profile.configuredModel,
      underlyingModel: profile.underlyingModel, availableEfforts: profile.supportedEfforts,
      profileRequestedEffort: profile.requestedProfileEffort, effortEvidence: profile.effortEvidence,
      modes: profile.id.startsWith('codex-') ? SCREENING_PROFILE_EVIDENCE.codex.modes
        : profile.id === 'zcode-glm-flash' ? Object.freeze(['plan', 'build', 'edit', 'yolo', 'auto']) : Object.freeze([]),
      tokenEnforcement: 'unsupported' as const,
    }))),
    unsupportedSettings: Object.freeze(unsupportedSettings), candidates: Object.freeze(candidates),
    candidateCount: candidates.length,
    trackCandidateCounts: Object.freeze({
      native: candidates.filter((candidate) => candidate.track === 'native').length,
      diagnostic: candidates.filter((candidate) => candidate.track === 'diagnostic').length,
    }),
  });
}

export interface FrozenScreeningDesignInput {
  readonly designId: string;
  readonly frozenAtUTC: string;
  readonly calibration: Readonly<{ cohortId: string; taskManifestHash: string; substrateManifestHash: string; pilotEvidenceHash: string }>;
  readonly heldOut: Readonly<{ cohortId: string; taskManifestHash: string; substrateManifestHash: string; reservedBeforeOutcomes: true }>;
  readonly promotionPolicy: Readonly<{
    minimumPairedSubstrates: number;
    promisingSuccessDifference: number;
    uncertaintyConfidence: number;
    retainIfUncertaintyHalfWidthAtLeast: number;
    alwaysRetainIndividualModelBaselines: true;
    calibrationOnly: true;
  }>;
  readonly tuningInputs: Readonly<{
    budgetPilotManifestHash: string;
    variancePilotManifestHash: string;
    budgetsDerivedFromPilot: true;
  }>;
}

export interface FrozenScreeningDesign extends FrozenScreeningDesignInput {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly catalogHash: string;
  readonly candidateIds: readonly string[];
  readonly tracks: readonly ScreeningTrack[];
  readonly heldOutSealedFromPromotion: true;
  readonly cohortPoolingAllowed: false;
  readonly designHash: string;
}

/** Freeze task split and numerical promotion/uncertainty rules before outcomes. */
export function freezeScreeningDesign(catalog: ScreeningCatalog, input: FrozenScreeningDesignInput): FrozenScreeningDesign {
  if (!input.designId || !isIsoDate(input.frozenAtUTC)) throw new Error('Screening design requires a stable id and ISO freeze timestamp');
  if (input.calibration.cohortId === input.heldOut.cohortId) throw new Error('Calibration and held-out cohorts must be distinct');
  if (!input.heldOut.reservedBeforeOutcomes) throw new Error('Held-out tasks must be reserved before any outcomes');
  for (const hash of [input.calibration.taskManifestHash, input.calibration.substrateManifestHash, input.calibration.pilotEvidenceHash,
    input.heldOut.taskManifestHash, input.heldOut.substrateManifestHash, input.tuningInputs.budgetPilotManifestHash, input.tuningInputs.variancePilotManifestHash]) assertHash(hash, 'screening design manifest hash');
  if (!input.tuningInputs.budgetsDerivedFromPilot) throw new Error('Screening budget tiers must cite calibration pilots');
  const policy = input.promotionPolicy;
  if (!Number.isSafeInteger(policy.minimumPairedSubstrates) || policy.minimumPairedSubstrates < 1
    || !unitInterval(policy.promisingSuccessDifference) || !unitInterval(policy.uncertaintyConfidence)
    || !unitInterval(policy.retainIfUncertaintyHalfWidthAtLeast)
    || !policy.alwaysRetainIndividualModelBaselines || !policy.calibrationOnly) {
    throw new Error('Promotion and uncertainty policy must be explicit, finite and calibration-only');
  }
  const body = {
    ...input, schemaVersion: 1 as const, catalogId: catalog.catalogId,
    catalogHash: sha256(canonical(catalog)), candidateIds: catalog.candidates.map((candidate) => candidate.candidateId),
    tracks: ['native', 'diagnostic'] as const, heldOutSealedFromPromotion: true as const, cohortPoolingAllowed: false as const,
  };
  return Object.freeze({ ...body, designHash: sha256(canonical(body)) });
}

/** Shape for later reports; it can only cite the frozen design and calibration cohort. */
export interface ScreeningComparisonArtifact {
  readonly schemaVersion: 1;
  readonly designHash: string;
  readonly catalogHash: string;
  readonly track: ScreeningTrack;
  readonly cohortId: string;
  readonly outcomeManifestHash: string;
  readonly comparisons: readonly {
    candidateId: string;
    assignmentCount: number;
    launchCount: number;
    validOutcomeCount: number;
    operationalCompletionRate: number | null;
    conditionalCorrectness: number | null;
    assignedStrategySuccess: number | null;
    pairedSubstrateCount: number;
    uncertaintyInterval95: readonly [number, number] | null;
    disposition: 'promoted' | 'retained-uncertain' | 'not-promoted' | 'unsupported' | 'unscreened';
    dispositionReason: string;
  }[];
  readonly heldOutOutcomeManifestHash: null;
  readonly cohortPoolingAllowed: false;
}

export type ScreeningComparisonRow = ScreeningComparisonArtifact['comparisons'][number];

/** Build one calibration-track artifact. Held-out IDs and pooled cohorts fail closed. */
export function createScreeningComparisonArtifact(
  catalog: ScreeningCatalog,
  design: FrozenScreeningDesign,
  track: ScreeningTrack,
  outcomeManifestHash: string,
  rows: readonly ScreeningComparisonRow[],
): ScreeningComparisonArtifact {
  if (design.catalogId !== catalog.catalogId || design.catalogHash !== sha256(canonical(catalog))) {
    throw new Error('Comparison artifact catalog does not match its frozen screening design');
  }
  assertHash(outcomeManifestHash, 'screening outcome manifest hash');
  const expected = catalog.candidates.filter((candidate) => candidate.track === track);
  const expectedIds = new Set(expected.map((candidate) => candidate.candidateId));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!expectedIds.has(row.candidateId) || seen.has(row.candidateId)) throw new Error(`Comparison row is outside the frozen ${track} design: ${row.candidateId}`);
    seen.add(row.candidateId);
    for (const [name, count] of [['assignmentCount', row.assignmentCount], ['launchCount', row.launchCount],
      ['validOutcomeCount', row.validOutcomeCount], ['pairedSubstrateCount', row.pairedSubstrateCount]] as const) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${row.candidateId}.${name} must be a non-negative integer`);
    }
    if (row.launchCount > row.assignmentCount || row.validOutcomeCount > row.launchCount || row.pairedSubstrateCount > row.validOutcomeCount) {
      throw new Error(`Invalid comparison denominators for ${row.candidateId}`);
    }
    for (const value of [row.operationalCompletionRate, row.conditionalCorrectness, row.assignedStrategySuccess]) {
      if (value !== null && !unitInterval(value)) throw new Error(`Invalid comparison rate for ${row.candidateId}`);
    }
    if (row.uncertaintyInterval95 && (!unitInterval(row.uncertaintyInterval95[0])
      || !unitInterval(row.uncertaintyInterval95[1]) || row.uncertaintyInterval95[0] > row.uncertaintyInterval95[1])) {
      throw new Error(`Invalid uncertainty interval for ${row.candidateId}`);
    }
  }
  if (rows.length !== expected.length) throw new Error(`Comparison artifact must retain every ${track} planned, unsupported and unscreened cell`);
  return deepFreeze({
    schemaVersion: 1 as const, designHash: design.designHash, catalogHash: design.catalogHash, track,
    cohortId: design.calibration.cohortId, outcomeManifestHash,
    comparisons: rows.map((row) => ({ ...row, uncertaintyInterval95: row.uncertaintyInterval95 ? [...row.uncertaintyInterval95] as [number, number] : null })),
    heldOutOutcomeManifestHash: null, cohortPoolingAllowed: false as const,
  });
}

function stageEnvelope(recipe: StrategyRecipe, tier: PerTaskBudgetTier): ChargedStageEnvelope {
  let stageCount: number;
  switch (recipe.kind) {
    case 'one-shot': stageCount = 1; break;
    case 'same-model-verify-repair': stageCount = (recipe.maxRepairs + 1) * 2; break;
    case 'candidate-selection': stageCount = recipe.candidateCount + 1; break;
    case 'mixed-model-verify-repair': stageCount = 2 + recipe.maxRepairs * 2; break;
    case 'cheap-first-escalation': stageCount = recipe.tiers.length + Math.max(0, recipe.tiers.length - 1); break;
  }
  const chargedStages = stageCount + 1;
  const chargedAttempts = stageCount + 1;
  return Object.freeze({
    chargedAttempts, chargedStages, modelOrScaffoldStages: stageCount, finalJudgeStages: 1,
    tierAttemptCap: tier.maxAttempts, tierStageCap: tier.maxStages,
    attemptLimitDisposition: chargedAttempts <= tier.maxAttempts ? 'fits' : 'bounded-truncation-possible',
    stageLimitDisposition: chargedStages <= tier.maxStages ? 'fits' : 'bounded-truncation-possible',
    sharedCumulativeWallMs: tier.wallClockMs,
    candidateWorkWallMs: tier.wallClockMs - tier.judgementAllowanceMs - tier.shutdownAllowanceMs - tier.observationAllowanceMs - tier.captureAllowanceMs,
    shutdownReserveMs: tier.shutdownAllowanceMs, observationReserveMs: tier.observationAllowanceMs,
    captureReserveMs: tier.captureAllowanceMs, independentJudgeReserveMs: tier.judgementAllowanceMs,
    tokenBudget: tier.tokenBudget ?? null, tokenCapClaim: 'none',
  });
}

function profileById(id: ScreeningProfile['id']): ScreeningProfile {
  const profile = SCREENING_PROFILES.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown screening profile: ${id}`);
  return profile;
}

function routeId(track: ScreeningTrack, profile: ScreeningProfile, effort: string | null): string {
  const safe = `${track}-${profile.id}${effort ? `-${effort}` : '-profile-requested'}`;
  return safe.replace(/[^A-Za-z0-9._-]/gu, '-');
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /^\d{4}-\d\d-\d\dT/u.test(value);
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}

function unitInterval(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
