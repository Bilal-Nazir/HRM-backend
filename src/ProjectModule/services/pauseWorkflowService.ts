import { createHash } from "node:crypto";
import WorkflowStatusModel from "../models/WorkflowStatus";
import ProjectModel from "../models/Project";

// New projects and existing workflows share one protected Pause column. The
// deterministic ID plus system-key index make concurrent repairs idempotent.
export async function ensurePauseStatus(project: any) {
  const projectId = String(project._id || project.id);
  const scope = {
    organizationId: project.organizationId,
    projectId,
    isDeleted: { $ne: true },
  };
  const preserveInitialColumn = async (columnId: string) => {
    const initial = await WorkflowStatusModel.findOne({
      ...scope,
      _id: { $ne: columnId },
      isArchived: false,
      category: { $in: ["todo", "in_progress"] },
    }).sort({ order: 1 });
    if (initial)
      await WorkflowStatusModel.updateOne(
        { _id: initial._id, ...scope },
        { $set: { isDefault: true } },
      );
  };
  let pause = await WorkflowStatusModel.findOne({
    ...scope,
    systemKey: "pause",
  });
  if (!pause) {
    const existing = await WorkflowStatusModel.findOne({
      ...scope,
      name: /^pause$/i,
      isArchived: false,
    }).sort({ order: 1, _id: 1 });
    if (existing) {
      if (existing.isDefault) await preserveInitialColumn(existing.id);
      try {
        pause = await WorkflowStatusModel.findOneAndUpdate(
          { _id: existing._id, ...scope },
          {
            $set: {
              systemKey: "pause",
              name: "Pause",
              category: "paused",
              timerAction: "stop",
              isArchived: false,
              isDefault: false,
            },
          },
          { new: true },
        );
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
      }
    } else {
      const last = await WorkflowStatusModel.findOne(scope).sort({ order: -1 });
      const id = createHash("sha256")
        .update(`${project.organizationId}:${projectId}:pause`)
        .digest("hex")
        .slice(0, 24);
      try {
        pause = await WorkflowStatusModel.findOneAndUpdate(
          { _id: id, organizationId: project.organizationId, projectId },
          {
            $set: {
              name: "Pause",
              category: "paused",
              systemKey: "pause",
              timerAction: "stop",
              isArchived: false,
              isDeleted: false,
              isDefault: false,
            },
            $setOnInsert: {
              order: (last?.order ?? -1) + 1,
              color: "#d99b32",
              allowedTransitionIds: [],
              moveRoles: ["project_manager", "member"],
            },
          },
          { upsert: true, new: true },
        );
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
      }
    }
    if (!pause)
      pause = await WorkflowStatusModel.findOne({
        ...scope,
        systemKey: "pause",
      });
  }
  if (!pause) throw new Error("Unable to initialize the Pause column");
  if (
    pause.isArchived ||
    pause.category !== "paused" ||
    pause.timerAction !== "stop" ||
    pause.name !== "Pause" ||
    pause.isDefault
  ) {
    if (pause.isDefault) await preserveInitialColumn(pause.id);
    pause.name = "Pause";
    pause.category = "paused";
    pause.timerAction = "stop";
    pause.isArchived = false;
    pause.isDefault = false;
    await pause.save();
  }
  if (project.pauseStatusId !== pause.id) {
    await ProjectModel.updateOne(
      { _id: projectId, organizationId: project.organizationId },
      { $set: { pauseStatusId: pause.id } },
    );
    project.pauseStatusId = pause.id;
  }
  return pause;
}
