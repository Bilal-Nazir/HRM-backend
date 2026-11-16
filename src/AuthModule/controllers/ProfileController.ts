import { randomUUID } from "crypto";
import sharp from "sharp";
import { isValidObjectId } from "mongoose";
import { Response } from "express";
import User from "../models/User";
import Employee from "../../EmployeeModule/models/Employee";
import { AuthenticatedRequest } from "../utils/types";
import { sessionProfile } from "../../TenantModule/services/companyContext";
import { companyChatPeople } from "../../ChatModule/services/chatAccess";
import {
  ObjectNotFoundException,
  UnauthenticatedException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";

export async function ownProfile(req: AuthenticatedRequest, res: Response) {
  const user = await User.findById(req.auth!.userId);
  if (!user) throw new UnauthenticatedException();
  const employee =
    req.auth!.employeeId && req.auth!.organizationId
      ? await Employee.findOne({
          _id: req.auth!.employeeId,
          organizationId: req.auth!.organizationId,
        }).select("firstName lastName employeeCode jobTitle")
      : null;
  res.set("Cache-Control", "no-store");
  return sendResponseObject({
    res,
    data: {
      user: sessionProfile(user, req.auth!),
      employee: employee
        ? {
            name: `${employee.firstName} ${employee.lastName}`.trim(),
            employeeCode: employee.employeeCode,
            jobTitle: employee.jobTitle,
          }
        : null,
    },
  });
}

export async function updatePhoto(req: AuthenticatedRequest, res: Response) {
  const data = req.body.data;
  if (
    typeof data !== "string" ||
    data.length > Math.ceil((5 * 1024 * 1024) / 3) * 4 + 64
  )
    throw new ValidationException("Choose a JPG, PNG or WebP image up to 5 MB");
  const match = data.match(
    /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match) throw new ValidationException("Choose a JPG, PNG or WebP image");
  const bytes = Buffer.from(match[2], "base64");
  if (
    !bytes.length ||
    bytes.length > 5 * 1024 * 1024 ||
    bytes.toString("base64") !== match[2]
  )
    throw new ValidationException("Invalid image data or image exceeds 5 MB");
  let photoData: Buffer;
  try {
    const image = sharp(bytes, {
      limitInputPixels: 24_000_000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      !["jpeg", "png", "webp"].includes(metadata.format || "") ||
      (metadata.pages || 1) > 1
    )
      throw new Error("Unsupported photo");
    // Decode and re-encode instead of storing the uploaded file. This also
    // removes EXIF/location metadata and produces a small, static avatar.
    photoData = await image
      .autoOrient()
      .resize(256, 256, { fit: "cover" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ValidationException(
      "This image could not be read. Use a static JPG, PNG or WebP photo under 24 megapixels.",
    );
  }
  const user = await User.findOneAndUpdate(
    { _id: req.auth!.userId, isActive: true, isDeleted: { $ne: true } },
    { $set: { photoData, photoVersion: randomUUID() } },
    { new: true },
  );
  if (!user) throw new UnauthenticatedException();
  res.set("Cache-Control", "no-store");
  return sendResponseObject({
    res,
    data: { user: sessionProfile(user, req.auth!) },
  });
}

export async function removePhoto(req: AuthenticatedRequest, res: Response) {
  const user = await User.findOneAndUpdate(
    { _id: req.auth!.userId, isActive: true, isDeleted: { $ne: true } },
    { $unset: { photoData: 1, photoVersion: 1 } },
    { new: true },
  );
  if (!user) throw new UnauthenticatedException();
  res.set("Cache-Control", "no-store");
  return sendResponseObject({
    res,
    data: { user: sessionProfile(user, req.auth!) },
  });
}

export async function personPhoto(req: AuthenticatedRequest, res: Response) {
  const id = String(req.params.userId);
  if (!isValidObjectId(id)) throw new ValidationException("Invalid person");
  const own = id === req.auth!.userId;
  if (!own) {
    if (
      !req.auth!.organizationId ||
      !(await companyChatPeople(req.auth!)).some(
        (person) => person.userId === id,
      )
    )
      throw new ObjectNotFoundException("Profile photo");
  }
  const user = await User.findOne({
    _id: id,
    isActive: true,
    isDeleted: { $ne: true },
  }).select("+photoData");
  if (!user?.photoData) throw new ObjectNotFoundException("Profile photo");
  res.set({
    "Content-Type": "image/jpeg",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline; filename=profile.jpg",
  });
  res.send(user.photoData);
}
