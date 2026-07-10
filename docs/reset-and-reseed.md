# Reset y re-carga de estudios

Seguir estos pasos cada vez que haya que limpiar la base de datos y volver a subir archivos DICOM desde cero (por ejemplo, después de corregir la extracción de tags).

---

## 1. Borrar todos los estudios

### 1a. Limpiar la tabla de estudios en PostgreSQL

```bash
docker exec -it micd-postgres \
  psql -U micd -d micd -c "TRUNCATE TABLE studies RESTART IDENTITY;"
```

### 1b. Borrar todos los estudios en Orthanc

```bash
for id in $(curl -s http://localhost:8042/studies -u orthanc:orthanc | python3 -c "import sys,json; [print(x) for x in json.load(sys.stdin)]"); do
  curl -s -X DELETE "http://localhost:8042/studies/$id" -u orthanc:orthanc
  echo "Deleted $id"
done
```

Verificar que quedó vacío:

```bash
curl -s http://localhost:3000/api/v1/studies | python3 -m json.tool
# Esperado: { "studies": [], "total": 0, ... }
```

---

## 2. Volver a subir los archivos DICOM

### Opción A — Carpeta con archivos reales

```bash
for f in /ruta/a/tus/dicoms/*.dcm; do
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST http://localhost:3000/api/v1/studies/upload \
    -F "file=@$f")
  echo "$status  $f"
done
```

Códigos esperados:

- `201` — subido correctamente
- `409` — duplicado (ya existe, omitir o usar `?force=true`)
- `400` — archivo inválido (no es DICOM)

### Opción B — Desde la UI

1. Abrir `http://localhost`
2. Click en **"Cargar carpeta"** en el panel izquierdo
3. Seleccionar la carpeta con los `.dcm`
4. Esperar que el panel derecho se actualice automáticamente

### Opción C — Archivos de prueba sintéticos (sin DICOM reales)

Genera 5 estudios con datos reales para testear los filtros:

```bash
node - <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const uid = () => '2.25.' + BigInt('0x'+crypto.randomBytes(16).toString('hex')).toString().slice(0,38);
const LONG = new Set(['OB','OD','OF','OL','OW','SQ','UC','UN','UR','UT']);
function tag(g, e, vr, v) {
  let val = vr==='US' ? (b=Buffer.alloc(2),b.writeUInt16LE(v,0),b)
          : vr==='UL' ? (b=Buffer.alloc(4),b.writeUInt32LE(v,0),b)
          : (vr==='OB'||vr==='OW') ? v
          : Buffer.from(v+(v.length%2?(vr==='UI'?'\0':' '):''),'latin1');
  const long = LONG.has(vr), h = Buffer.alloc(long?12:8);
  h.writeUInt16LE(g,0); h.writeUInt16LE(e,2);
  Buffer.from(vr).copy(h,4);
  long ? (h.writeUInt16LE(0,6), h.writeUInt32LE(val.length,8))
       : h.writeUInt16LE(val.length,6);
  return Buffer.concat([h,val]);
}
function make(name, pid, mod, date, desc) {
  const sop=uid(), study=uid(), series=uid(), cls='1.2.840.10008.5.1.4.1.1.2', ts='1.2.840.10008.1.2.1';
  const meta = Buffer.concat([tag(2,1,'OB',Buffer.from([0,1])),tag(2,2,'UI',cls),tag(2,3,'UI',sop),tag(2,16,'UI',ts)]);
  const pix  = Buffer.alloc(32,0); pix.writeUInt16LE(1024,0);
  const ds   = Buffer.concat([
    tag(8,22,'UI',cls),tag(8,24,'UI',sop),tag(8,32,'DA',date),tag(8,33,'DA',date),
    tag(8,96,'CS',mod),tag(8,4158,'LO',desc),tag(8,4144,'LO',desc),
    tag(16,16,'PN',name),tag(16,32,'LO',pid),
    tag(32,13,'UI',study),tag(32,14,'UI',series),tag(32,19,'IS','1'),
    tag(40,2,'US',1),tag(40,4,'CS','MONOCHROME2'),tag(40,16,'US',4),tag(40,17,'US',4),
    tag(40,256,'US',16),tag(40,257,'US',16),tag(40,258,'US',15),tag(40,259,'US',0),
    tag(0x7FE0,16,'OW',pix),
  ]);
  const ml = tag(2,0,'UL',meta.length);
  return Buffer.concat([Buffer.alloc(128,0),Buffer.from('DICM'),ml,meta,ds]);
}
fs.mkdirSync('/tmp/test-dicoms',{recursive:true});
[
  ['Garcia^Juan','P001','CT','20240315','Torax con contraste'],
  ['Lopez^Maria','P002','MR','20240520','Cerebro FLAIR'],
  ['Perez^Carlos','P003','CR','20230810','Rx Torax PA'],
  ['Gomez^Ana','P004','CT','20241201','Abdomen sin contraste'],
  ['Torres^Luis','P005','MR','20240710','Columna lumbar'],
].forEach(([n,p,m,d,desc]) => {
  const path=`/tmp/test-dicoms/${p}_${m}.dcm`;
  fs.writeFileSync(path, make(n,p,m,d,desc));
  console.log('Created', path);
});
EOF
```

Luego subir:

```bash
for f in /tmp/test-dicoms/*.dcm; do
  result=$(curl -s -X POST http://localhost:3000/api/v1/studies/upload -F "file=@$f")
  echo "$f → $(echo $result | python3 -c 'import sys,json; s=json.load(sys.stdin).get("study",{}); print(s.get("patient_name","ERR"), s.get("modality","?"))' 2>/dev/null)"
done
```

---

## 3. Verificar

```bash
curl -s http://localhost:3000/api/v1/studies | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Total estudios: {d[\"total\"]}')
for s in d['studies']:
    print(f'  {s[\"patient_name\"]:20} {s[\"modality\"]:4} {s[\"study_date\"]}')
"
```

Salida esperada (con archivos de prueba):

```
Total estudios: 5
  Torres^Luis          MR   20240710
  Gomez^Ana            CT   20241201
  Perez^Carlos         CR   20230810
  Lopez^Maria          MR   20240520
  Garcia^Juan          CT   20240315
```

Después abrir `http://localhost` — el explorador del panel derecho debe mostrar los 5 estudios con nombre, modalidad, fecha y badge correctos.
