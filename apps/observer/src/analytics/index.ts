export {
  TrajectoryAttributionContextSchema,
  type TrajectoryAttributionContext,
  type TrajectoryAttributionContextInput,
  TrajectoryValidationError,
  MixedTrajectoryIdentityError,
  TrajectoryAlreadyFinalizedError,
  computeTrajectoryObservationDigest,
  TrajectoryEmitter,
  createTrajectoryEmitter,
  aggregateTrajectoryEvents,
} from "./trajectory-emitter.js";

export {
  type TrajectoryAttributionResolverFn,
  type TrajectoryAttributionResolverObject,
  type TrajectoryAttributionResolver,
  type TrajectoryCaptureCoordinatorOptions,
  type SessionEventSink,
  type SessionEventSinkContext,
  TrajectoryCaptureCoordinator,
} from "./capture-coordinator.js";

export {
  projectEventToMetadataOnly,
  projectEventMetadataOnly,
  extractParameterShape,
  extractParameterTypeShape,
  tryPreserveSafeParameterShapeEnvelope,
  projectToolParameters,
  ALLOWED_PRIMITIVE_KINDS,
  RESIN_PARAMETER_SHAPE_KEY,
  DEFAULT_MAX_DEPTH,
  HARD_MAX_DEPTH,
  DEFAULT_MAX_KEYS,
  HARD_MAX_KEYS,
  DEFAULT_MAX_KEY_LENGTH,
  HARD_MAX_KEY_LENGTH,
  DEFAULT_MAX_NODES,
  HARD_MAX_NODES,
  type ParameterPrimitiveKind,
  type ParameterShapeDescriptor,
  type ParameterShapeOptions,
} from "./metadata-projection.js";

export { MetadataEventProjector } from "./metadata-event-projector.js";

export {
  type InvocationTelemetryUploaderOptions,
  InvocationTelemetryUploader,
} from "./invocation-telemetry-uploader.js";

export {
  type DerivationCall,
  type DerivedCall,
  type ExecutionArgument,
  type ExecutionRecording,
  type NativeDerivation,
  type ObservedResourceFlow,
  deriveNativeCalls,
  proposeInputsAcrossExecutions,
} from "./native-argument-derivation.js";

export {
  type ToolLinkEvidenceRecorderOptions,
  ToolLinkEvidenceRecorder,
  createToolLinkEvidenceRecorder,
} from "./tool-links/recorder.js";

export {
  extractRawCommandStringFromEvent,
  isDeterministicCommandSequence,
  parseDeterministicCommandSequence,
  projectDeterministicCommandSequence,
  projectDeterministicCommandSequenceFromEvent,
  safeParseDeterministicCommandSequence,
} from "./deterministic-command-sequence.js";

export { compareRecordedEvents } from "./recorded-event-order.js";
