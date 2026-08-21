import { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import * as studiesService from "./studies.service";

export const listOrthancStudies: RequestHandler = async (_req, res) => {
  try {
    res.json(await studiesService.listOrthancStudies());
  } catch (err) {
    sendError(res, err);
  }
};

export const getOrthancStudy: RequestHandler = async (req, res) => {
  try {
    res.json(await studiesService.getOrthancStudy(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
};

export const deleteOrthancStudy: RequestHandler = async (req, res) => {
  try {
    await studiesService.deleteOrthancStudy(req.params.id);
    res.status(204).send();
  } catch (err) {
    sendError(res, err);
  }
};

export const getStudyFile: RequestHandler = async (req, res) => {
  try {
    const buffer = await studiesService.getStudyDicomFile(req.params.studyId);
    res.setHeader("Content-Type", "application/dicom");
    res.send(buffer);
  } catch (err) {
    sendError(res, err);
  }
};

export const getStudyInstances: RequestHandler = async (req, res) => {
  try {
    res.json(await studiesService.getStudyInstances(req.params.studyId));
  } catch (err) {
    sendError(res, err);
  }
};

export const getInstanceFile: RequestHandler = async (req, res) => {
  try {
    const buffer = await studiesService.getInstanceDicomFile(
      req.params.studyId,
      req.params.instanceId,
    );
    res.setHeader("Content-Type", "application/dicom");
    res.send(buffer);
  } catch (err) {
    sendError(res, err);
  }
};

export const listStudies: RequestHandler = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit as string) || 20),
    );
    const filters = {
      modality: (req.query.modality as string) || null,
      dateFrom: (req.query.date_from as string) || null,
      dateTo: (req.query.date_to as string) || null,
      search: (req.query.search as string) || null,
      zenodoLinked: req.query.zenodo_linked === "true" ? true : null,
    };
    const result = await studiesService.listStudies(
      page,
      limit,
      filters,
      req.user!.role,
    );
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};

export const getStudyThumbnail: RequestHandler = async (req, res) => {
  try {
    const { buffer, contentType } = await studiesService.getStudyThumbnail(
      req.params.studyId,
    );
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (err) {
    sendError(res, err);
  }
};

export const getStudyZenodo: RequestHandler = async (req, res) => {
  try {
    res.json(await studiesService.getStudyZenodoDetail(req.params.studyId));
  } catch (err) {
    sendError(res, err);
  }
};

export const checkStudyZenodo: RequestHandler = async (req, res) => {
  try {
    const result = await studiesService.checkStudyZenodoVersion(req.params.studyId, {
      userId: Number(req.user!.sub),
      ip: req.ip ?? "",
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};
