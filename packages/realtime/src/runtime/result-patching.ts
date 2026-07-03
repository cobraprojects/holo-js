export {
  EMPTY_RESULT_PATH,
  EMPTY_RESULT_PATH_KEY,
  copyPatchPath,
  createResultPathKey,
  getValueAtPath,
  type RealtimePatchPathSegment,
} from './result-path'

export {
  replacePatchedQueryDataWithPlan,
  type PatchedQueryDataReplacement,
  type PatchedQueryDataReplacementQuery,
} from './result-query-data-replacement'

export {
  replaceTwoValuesAtPaths,
  replaceValuesAtPaths,
  replaceValuesAtPathsUsing,
  spliceValueAtPath,
  spliceValuesAtPath,
  type PathValueReplacement,
} from './result-multi-replacement'

export {
  applyTopLevelPathReplacement,
  canReplaceTopLevelPath,
  finishTopLevelPathReplacement,
  type TopLevelReplacementResult,
  type TopLevelReplacementState,
} from './result-top-level-replacement'

export {
  copyArrayWithReplacement,
  copyRecordWithReplacement,
  replaceValueAtPath,
} from './result-value-replacement'
