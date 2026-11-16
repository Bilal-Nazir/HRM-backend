import { Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import {
  ConflictException,
  ForbiddenException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import Receipt from "../models/Receipt";
import {
  accessibleChatProjects,
  chatAccess,
  chatId,
  companyChatPeople,
  conversationPeople,
} from "../services/chatAccess";

const dto = (row: any, readCount = 0) => ({
  id: String(row._id),
  conversationId: String(row.conversationId),
  senderUserId: String(row.senderUserId),
  senderName: row.senderName,
  body: row.body,
  createdAt: row.createdAt,
  mentions: (row.mentionedUserIds || []).map((id: any, index: number) => ({
    userId: String(id),
    name: row.mentionedNames[index],
  })),
  replyTo: row.replyToMessageId
    ? {
        id: String(row.replyToMessageId),
        authorName: row.replyToName,
        body: row.replyToBody,
      }
    : null,
  readCount,
  recipientCount: row.recipientUserIds?.length || 0,
});
const duplicate = (error: any) => error?.code === 11000;

export async function directory(req: AuthenticatedRequest, res: Response) {
  const [people, projects] = await Promise.all([
    companyChatPeople(req.auth!),
    accessibleChatProjects(req.auth!),
  ]);
  return sendResponseObject({
    res,
    data: {
      people: people.filter((person) => person.userId !== req.auth!.userId),
      projects: projects.map((project) => ({
        id: String(project._id),
        name: project.name,
        key: project.key,
        status: project.status,
      })),
    },
  });
}

export async function startDirect(req: AuthenticatedRequest, res: Response) {
  const recipient = chatId(req.body.userId, "recipient ID");
  if (recipient === req.auth!.userId)
    throw new ValidationException("Choose another person to message");
  const people = await companyChatPeople(req.auth!);
  if (!people.some((person) => person.userId === recipient))
    throw new ObjectNotFoundException("Company member");
  const participantUserIds = [req.auth!.userId, recipient].sort(),
    directKey = participantUserIds.join(":");
  const filter = {
    organizationId: req.auth!.organizationId,
    kind: "direct",
    directKey,
  };
  let conversation;
  try {
    conversation = await Conversation.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          ...filter,
          participantUserIds,
          participantNames: participantUserIds.map(
            (id) =>
              people.find((person) => person.userId === id)?.name ||
              "Team member",
          ),
          createdByUserId: req.auth!.userId,
          isDeleted: false,
        },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (!duplicate(error)) throw error;
    conversation = await Conversation.findOne(filter);
  }
  return sendResponseObject({
    res,
    data: { conversationId: conversation!.id },
  });
}

export async function startProject(req: AuthenticatedRequest, res: Response) {
  const projectId = chatId(req.params.projectId, "project ID");
  const project = (await accessibleChatProjects(req.auth!)).find(
    (project) => String(project._id) === projectId,
  );
  if (!project) throw new ObjectNotFoundException("Project");
  const filter = {
    organizationId: req.auth!.organizationId,
    kind: "project",
    projectId,
  };
  let conversation;
  try {
    conversation = await Conversation.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          ...filter,
          createdByUserId: req.auth!.userId,
          isDeleted: false,
        },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (!duplicate(error)) throw error;
    conversation = await Conversation.findOne(filter);
  }
  return sendResponseObject({
    res,
    data: { conversationId: conversation!.id },
  });
}

export async function inbox(req: AuthenticatedRequest, res: Response) {
  const organizationId = req.auth!.organizationId!,
    userId = req.auth!.userId;
  const [projects, people] = await Promise.all([
    accessibleChatProjects(req.auth!),
    companyChatPeople(req.auth!),
  ]);
  const rows = await Conversation.find({
    organizationId,
    isDeleted: { $ne: true },
    $or: [
      { kind: "direct", participantUserIds: userId },
      {
        kind: "project",
        projectId: { $in: projects.map((project) => project._id) },
      },
    ],
  })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .lean();
  const unread = await Receipt.aggregate([
    {
      $match: {
        organizationId,
        recipientUserId: userId,
        conversationId: { $in: rows.map((row) => row._id) },
        readAt: { $exists: false },
        isDeleted: { $ne: true },
      },
    },
    {
      $group: {
        _id: "$conversationId",
        count: { $sum: 1 },
        mentions: { $sum: { $cond: ["$mentioned", 1, 0] } },
      },
    },
  ]);
  const counts = new Map(unread.map((row) => [String(row._id), row]));
  const conversations = rows.map((row) => {
    const project = projects.find(
      (project) => String(project._id) === row.projectId,
    );
    const index = row.participantUserIds.findIndex((id) => id !== userId),
      otherId = row.participantUserIds[index];
    const other = people.find((person) => person.userId === otherId),
      count = counts.get(String(row._id));
    return {
      id: String(row._id),
      kind: row.kind,
      projectId: row.projectId,
      title:
        row.kind === "project"
          ? project!.name
          : other?.name || row.participantNames[index] || "Former team member",
      projectKey: project?.key,
      otherUserId: row.kind === "direct" ? otherId : undefined,
      photoVersion: row.kind === "direct" ? other?.photoVersion : undefined,
      isReadOnly:
        row.kind === "project" ? project?.status === "archived" : !other,
      lastMessage: row.lastMessagePreview || "",
      lastMessageAt: row.lastMessageAt,
      unreadCount: count?.count || 0,
      mentionCount: count?.mentions || 0,
    };
  });
  return sendResponseObject({
    res,
    data: {
      conversations,
      unreadCount: unread.reduce((sum, row) => sum + row.count, 0),
      unreadConversations: unread.length,
      mentionCount: unread.reduce((sum, row) => sum + row.mentions, 0),
    },
  });
}

export async function conversationDetails(
  req: AuthenticatedRequest,
  res: Response,
) {
  const { conversation, project, readOnly } = await chatAccess(
    req.auth!,
    req.params.id,
  );
  const people = await conversationPeople(req.auth!, conversation);
  const otherIndex = conversation.participantUserIds.findIndex(
    (id) => id !== req.auth!.userId,
  );
  const other = people.find((person) => person.userId !== req.auth!.userId);
  return sendResponseObject({
    res,
    data: {
      conversation: {
        id: conversation.id,
        kind: conversation.kind,
        projectId: conversation.projectId,
        title:
          project?.name ||
          other?.name ||
          conversation.participantNames[otherIndex] ||
          "Former team member",
        projectKey: project?.key,
        otherUserId: conversation.kind === "direct" ? other?.userId : undefined,
        photoVersion:
          conversation.kind === "direct" ? other?.photoVersion : undefined,
        isReadOnly: project ? readOnly : !other,
      },
      people,
    },
  });
}

export async function messages(req: AuthenticatedRequest, res: Response) {
  const { conversation } = await chatAccess(req.auth!, req.params.id);
  const organizationId = req.auth!.organizationId!,
    size = Math.min(100, Math.max(1, Number(req.query.size) || 50));
  if (req.query.before && req.query.after)
    throw new ValidationException("Use one message cursor at a time");
  let boundary: any = {};
  if (req.query.before || req.query.after) {
    const id = chatId(req.query.before || req.query.after, "message cursor"),
      cursor = await Message.findOne({
        _id: id,
        organizationId,
        conversationId: conversation.id,
      }).select("createdAt");
    if (!cursor) throw new ValidationException("Invalid message cursor");
    const comparison = req.query.after ? "$gt" : "$lt";
    boundary = {
      $or: [
        { createdAt: { [comparison]: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { [comparison]: id } },
      ],
    };
  }
  const direction = req.query.after ? 1 : -1;
  const rows = await Message.find({
    organizationId,
    conversationId: conversation.id,
    isDeleted: { $ne: true },
    ...(req.query.mentions === "1" && { mentionedUserIds: req.auth!.userId }),
    ...boundary,
  })
    .sort({ createdAt: direction, _id: direction })
    .limit(size + 1)
    .lean();
  const hasMore = rows.length > size;
  rows.splice(size);
  if (!req.query.after) rows.reverse();
  const reads = await Receipt.aggregate([
    {
      $match: {
        organizationId,
        conversationId: conversation.id,
        messageId: { $in: rows.map((row) => row._id) },
        readAt: { $exists: true },
      },
    },
    { $group: { _id: "$messageId", count: { $sum: 1 } } },
  ]);
  const counts = new Map(reads.map((row) => [String(row._id), row.count]));
  return sendResponseObject({
    res,
    data: {
      messages: rows.map((row) => dto(row, counts.get(String(row._id)) || 0)),
      hasMore,
    },
  });
}

export async function sendMessage(req: AuthenticatedRequest, res: Response) {
  const { conversation, project, readOnly } = await chatAccess(
    req.auth!,
    req.params.id,
  );
  if (project?.status === "archived")
    throw new ConflictException("Archived project chats are read-only");
  if (readOnly)
    throw new ForbiddenException(
      "Project viewers cannot send messages in this group",
    );
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "",
    clientMessageId = req.body.clientMessageId;
  if (!body || body.length > 5000)
    throw new ValidationException(
      "Messages must be between 1 and 5000 characters",
    );
  if (
    typeof clientMessageId !== "string" ||
    !/^[a-zA-Z0-9_-]{16,80}$/.test(clientMessageId)
  )
    throw new ValidationException("A valid client message ID is required");
  const people = await conversationPeople(req.auth!, conversation);
  if (conversation.kind === "direct" && people.length !== 2)
    throw new ConflictException(
      "This person is no longer an active company member",
    );
  const author = people.find((person) => person.userId === req.auth!.userId);
  if (!author) throw new ObjectNotFoundException("Company member");
  const mentionedIds = req.body.mentionedUserIds ?? [];
  if (!Array.isArray(mentionedIds) || mentionedIds.length > 50)
    throw new ValidationException("Invalid mentions");
  const mentionedUserIds: string[] = [
    ...new Set(mentionedIds.map((id) => chatId(id, "mention ID"))),
  ];
  const mentions = mentionedUserIds.map((userId) => {
    const person = people.find((person) => person.userId === userId);
    const escapedName = person?.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      !person ||
      !new RegExp(`(?:^|\\s)@${escapedName}(?=$|[\\s.,!?;:)\\]])`).test(body)
    )
      throw new ValidationException(
        "You may only mention members of this conversation",
      );
    return person;
  });
  let reply: any = null;
  if (req.body.replyToMessageId) {
    reply = await Message.findOne({
      _id: chatId(req.body.replyToMessageId, "reply ID"),
      organizationId: req.auth!.organizationId,
      conversationId: conversation.id,
      isDeleted: { $ne: true },
    });
    if (!reply)
      throw new ValidationException(
        "Reply must refer to a message in this conversation",
      );
  }
  const key = {
    organizationId: req.auth!.organizationId,
    conversationId: conversation.id,
    senderUserId: req.auth!.userId,
    clientMessageId,
  };
  let message = await Message.findOne(key);
  if (
    message &&
    (message.body !== body ||
      message.replyToMessageId !== (reply?.id || undefined) ||
      JSON.stringify([...message.mentionedUserIds].sort()) !==
        JSON.stringify([...mentionedUserIds].sort()))
  )
    throw new ConflictException(
      "This message ID has already been used for another message",
    );
  if (!message) {
    try {
      message = await Message.create({
        ...key,
        senderName: author.name,
        body,
        recipientUserIds: people
          .map((person) => person.userId)
          .filter((userId) => userId !== req.auth!.userId),
        mentionedUserIds,
        mentionedNames: mentions.map((person) => person.name),
        replyToMessageId: reply?.id,
        replyToName: reply?.senderName,
        replyToBody: reply?.body.slice(0, 240),
      });
    } catch (error) {
      if (!duplicate(error)) throw error;
      message = await Message.findOne(key);
    }
  }
  if (
    message &&
    (message.body !== body ||
      message.replyToMessageId !== (reply?.id || undefined) ||
      JSON.stringify([...message.mentionedUserIds].sort()) !==
        JSON.stringify([...mentionedUserIds].sort()))
  )
    throw new ConflictException(
      "This message ID has already been used for another message",
    );
  // Upserts make retries safe even if a prior request disconnected after storing
  // the message but before completing recipient fanout.
  if (message!.recipientUserIds.length) {
    try {
      await Receipt.bulkWrite(
        message!.recipientUserIds.map((recipientUserId) => ({
          updateOne: {
            filter: {
              organizationId: req.auth!.organizationId,
              messageId: message!.id,
              recipientUserId,
            },
            update: {
              $setOnInsert: {
                organizationId: req.auth!.organizationId,
                conversationId: conversation.id,
                messageId: message!.id,
                recipientUserId,
                mentioned:
                  conversation.kind === "project" &&
                  message!.mentionedUserIds.includes(recipientUserId),
                isDeleted: false,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (error: any) {
      // Concurrent retries may race on the receipt's unique index. Every other
      // write failure must still fail the request so the caller can retry.
      const failures = error?.writeErrors;
      if (
        !Array.isArray(failures) ||
        !failures.length ||
        failures.some((failure: any) => failure.code !== 11000) ||
        error.writeConcernErrors?.length ||
        error.writeConcernError
      )
        throw error;
    }
  }
  await Conversation.updateOne(
    {
      _id: conversation.id,
      $or: [
        { lastMessageAt: { $exists: false } },
        { lastMessageAt: { $lt: message!.createdAt } },
        {
          lastMessageAt: message!.createdAt,
          lastMessageId: { $lte: message!.id },
        },
      ],
    },
    {
      $set: {
        lastMessageId: message!.id,
        lastMessageAt: message!.createdAt,
        lastMessagePreview: message!.body.slice(0, 180),
      },
    },
  );
  return sendResponseObject({
    res,
    code: 201,
    data: { message: dto(message!.toObject()) },
  });
}

export async function markRead(req: AuthenticatedRequest, res: Response) {
  const { conversation } = await chatAccess(req.auth!, req.params.id);
  if (!Array.isArray(req.body.messageIds) || req.body.messageIds.length > 100)
    throw new ValidationException(
      "Choose at most 100 messages to mark as read",
    );
  const messageIds = req.body.messageIds.map((id: unknown) =>
    chatId(id, "message ID"),
  );
  await Receipt.updateMany(
    {
      organizationId: req.auth!.organizationId,
      conversationId: conversation.id,
      recipientUserId: req.auth!.userId,
      messageId: { $in: messageIds },
      readAt: { $exists: false },
    },
    { $set: { readAt: new Date() } },
  );
  return sendResponseObject({ res, data: { success: true } });
}

export async function markConversationRead(
  req: AuthenticatedRequest,
  res: Response,
) {
  const { conversation } = await chatAccess(req.auth!, req.params.id);
  await Receipt.updateMany(
    {
      organizationId: req.auth!.organizationId,
      conversationId: conversation.id,
      recipientUserId: req.auth!.userId,
      readAt: { $exists: false },
    },
    { $set: { readAt: new Date() } },
  );
  return sendResponseObject({ res, data: { success: true } });
}
