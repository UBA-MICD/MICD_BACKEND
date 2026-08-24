import type { RequestHandler } from "express";
import { listActivity, exportActivityCsv } from "./activity.service";

export const getActivity: RequestHandler = async (req, res, next) => {
  try {
    const { result, date_from, date_to, user_id, page, limit } = req.query as Record<
      string,
      string | undefined
    >;
    const actionRaw = req.query["action"];
    const action = Array.isArray(actionRaw)
      ? (actionRaw as string[])
      : typeof actionRaw === "string"
        ? actionRaw
        : undefined;

    const result_ = result === "error" || result === "success" ? result : undefined;

    const data = await listActivity({
      action,
      result: result_,
      dateFrom: date_from,
      dateTo: date_to,
      userId: user_id ? parseInt(user_id, 10) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
};

export const exportActivity: RequestHandler = async (req, res, next) => {
  try {
    const { result, date_from, date_to, user_id } = req.query as Record<
      string,
      string | undefined
    >;
    const actionRaw = req.query["action"];
    const action = Array.isArray(actionRaw)
      ? (actionRaw as string[])
      : typeof actionRaw === "string"
        ? actionRaw
        : undefined;

    const result_ = result === "error" || result === "success" ? result : undefined;

    const csv = await exportActivityCsv({
      action,
      result: result_,
      dateFrom: date_from,
      dateTo: date_to,
      userId: user_id ? parseInt(user_id, 10) : undefined,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=audit-log.csv");
    res.send(csv);
  } catch (err) {
    next(err);
  }
};
