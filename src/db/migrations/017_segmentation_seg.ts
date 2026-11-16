// Migration 017 — DICOM SEG export (TK-45, evolución a DICOM SEG).
//
// Cuando un validador acepta una segmentación, el backend construye un objeto
// DICOM SEG (en el servicio de inferencias) y lo hace C-STORE a Orthanc como
// serie derivada. Estas columnas enlazan el candidato de `ml_segmentations` con
// el objeto SEG resultante (trazabilidad: qué objeto PACS salió de qué candidato).

const DDL = `
  ALTER TABLE ml_segmentations
    ADD COLUMN IF NOT EXISTS seg_sop_instance_uid    TEXT,
    ADD COLUMN IF NOT EXISTS seg_series_instance_uid TEXT,
    ADD COLUMN IF NOT EXISTS seg_exported_at         TIMESTAMPTZ;
`;

export const migration017 = {
  id: "017_segmentation_seg",
  sql: DDL,
};
