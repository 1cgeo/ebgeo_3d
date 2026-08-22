# API

Base em desenvolvimento: `http://localhost:8082`.
Base em produção: `/ebgeo_3d` (o proxy repassa `/api/v1/...`).

Toda resposta de erro tem o mesmo envelope: `{ "error": "..." }`.

---

## `GET /health`

Sonda. Não depende de nenhum banco de modelo.

```json
{
  "status": "ok",
  "models": 1,
  "tiles": 7501,
  "bytes": 308469760,
  "connections": { "open": 3, "limit": 12 }
}
```

`connections` mostra o LRU de bancos abertos. Se `open` bater no `limit` a toda
sonda, o LRU está girando e a navegação paga reabertura de banco: é o sinal para
subir `MAX_OPEN_MODELS` ou baixar `MODEL_CACHE_SIZE_KB`.

Responde `503` com `{ status, message }` quando o `index.db` não abre.

---

## `GET /api/v1/models`

O catálogo, já no formato do array `config.tilesets` do `ebgeo_web`.

| parâmetro | efeito |
|---|---|
| `base` | prefixo público das URLs (ex.: `/ebgeo_3d`) |

O `base` existe porque o serviço **não enxerga** o prefixo sob o qual é
publicado: o proxy recebe `/ebgeo_3d/...` e repassa `/api/v1/...`. Montar a URL
aqui sem ele daria um caminho que responde 404 do lado de fora.

```json
{
  "count": 1,
  "tilesets": [
    {
      "id": "ponte-quatis",
      "name": "Ponte General Osório (Quatis)",
      "type": "3dtiles",
      "url": "/ebgeo_3d/api/v1/models/ponte-quatis/tileset.json",
      "heightOffset": 0,
      "groundHeight": 343.2,
      "locate": { "lon": -44.286984, "lat": -22.400374, "height": 843.2 },
      "formato": {
        "tilesVersion": "1.1",
        "geometry": "draco",
        "texture": "ktx2-etc1s",
        "textureQuality": 200,
        "tiles": 7501,
        "bytes": 308469760,
        "buildToken": "mt4b2d00",
        "builtAt": "2026-08-22T11:41:27.325Z",
        "source": "Agisoft Metashape"
      }
    }
  ]
}
```

`Cache-Control: public, max-age=300`.

Modelo com `published = 0` não aparece.

## `GET /api/v1/assets/*`

Miniatura e vídeo de prévia dos modelos, servidos como arquivo de
`data/assets/`. Espelha o `/api/v1/thumbnails/` do ebgeo_360.

**A prévia DERIVA DO SLUG, e não de uma coluna do catálogo.** Para publicar a
miniatura do modelo `ponte-quatis`, ponha `data/assets/ponte-quatis.webp`. O
vídeo é `ponte-quatis.webm`. Nada a gravar no banco.

A alternativa (guardar o caminho numa coluna) duplica estado: publicar exigiria
copiar o arquivo E gravar o caminho, e esquecer o segundo passo some com a
imagem sem erro nenhum.

**O campo `previewThumbnail` sai SEM o `/api/v1`**, como `/assets/ponte-quatis.webp`.
O consumidor concatena com a base que só ele conhece, do mesmo jeito que faz com
o `previewThumbnail` do ebgeo_360. Essa base já traz o `/api/v1` em
desenvolvimento e o prefixo do proxy em produção.

O catálogo só publica o campo quando o arquivo existe. Sem isso todo modelo
publicaria uma URL, e o card do EBGeo mostraria imagem partida em vez de cair
para o ícone padrão.

`Cache-Control: public, max-age=3600`. Uma hora, e **não** `immutable`: a URL da
prévia não carrega token de geração, então trocar a miniatura tem de aparecer no
cliente.

---

`groundHeight` é a altura elipsoidal do chão, medida na importação. O cliente que
não tem terreno vê o modelo flutuar exatamente essa altura, e o contorno é
publicar `heightOffset = -groundHeight`. Ver `docs/operacao.md`, "Modelo que
flutua".

---

## `GET /api/v1/models/:id.json`

A ficha de um modelo, com as três últimas importações.

O `.json` no fim não é enfeite: sem ele esta rota e a rota curinga de conteúdo
disputariam o mesmo espaço de nomes, e um modelo chamado `tileset.json` viraria
ambiguidade.

Responde `404` se o modelo não existe ou não está publicado.

---

## `GET /api/v1/models/:id/*`

O conteúdo do modelo. É por aqui que sai o `tileset.json` e todo tile.

O curinga entrega exatamente a chave guardada no banco. O CesiumJS pede o
`tileset.json` e resolve tudo que vem dentro dele relativo a essa URL, então a
árvore inteira cai nesta rota sem que o cliente saiba que do outro lado há um
SQLite em vez de um diretório.

```
GET /api/v1/models/ponte-quatis/tileset.json
GET /api/v1/models/ponte-quatis/Data/d000/c00.glb?v=mt4b2d00
```

### Cabeçalhos

| conteúdo | `Cache-Control` | tipo |
|---|---|---|
| `.json` | `public, no-cache` mais ETag | `application/json; charset=utf-8` |
| `.glb` | `public, max-age=31536000, immutable` mais ETag | `model/gltf-binary` |
| `.ktx2` | idem | `image/ktx2` |
| demais | idem | pelo mapa de extensões |

O `immutable` só é seguro porque a `uri` carrega o token de geração. Ver
[formato.md](formato.md).

### O `?v=`

É ignorado pelo handler, de propósito. Ele não é parâmetro: é o que separa a URL
do tile velho da do novo, e quem o consome é o cache.

E não se compara com o token de hoje. No instante seguinte a uma reimportação o
cliente ainda segura o `tileset.json` anterior; recusar o token velho pintaria a
cena de buraco em vez de servir o tile bom.

### Códigos

| código | quando |
|---|---|
| `200` | achou |
| `304` | `If-None-Match` bateu com o ETag |
| `400` | chave vazia, com `..`, ou percent-encoding malformado |
| `404` | modelo não existe, não está publicado, ou a chave não está no banco |

### Concorrência

A rota tem semáforo próprio, com teto em `MAX_INFLIGHT_TILES` (64 por padrão). A
vaga cobre o BLOB: pega-se antes de ler e solta-se quando a resposta fecha, que é
o tempo em que o buffer vive no heap.

O caminho do `304` não pega vaga: ele não carrega BLOB nenhum, e enfileirá-lo
seria custo sem contrapartida.

---

## Compressão

O `@fastify/compress` cobre `text/*` e `application/json`. O `.glb` fica **fora**
de propósito: dentro dele a geometria já está em Draco e a textura em ETC1S, dois
formatos que quase não cedem ao gzip e cobrariam CPU do servidor a cada tile.
