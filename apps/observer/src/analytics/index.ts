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
  TrajectoryCaptureCoordinator,
} from "./capture-coordinator.js";

export {
  projectEventToMetadataOnly,
  projectEventMetadataOnly,
  extractParameterShape,
  extractParameterTypeShape,
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
