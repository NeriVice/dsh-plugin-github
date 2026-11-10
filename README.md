# dsh-plugin-github

Plugin de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) que conecta tus
repositorios de GitHub a la sesión: listar y buscar repos, ver detalles, leer issues y pull
requests, abrir issues y traer un repositorio al workspace.

Ya está instalado en el perfil `web` (ver [Instalación](#instalación)). Solo falta el token.

---

## 1. Crear el token (2 minutos)

Sin token el plugin funciona en modo anónimo: solo lectura de repos públicos y 60 peticiones por
hora. Para repos privados y límites altos (5000/h) hace falta un token.

**Opción A — fine-grained (recomendado).** Entrá a <https://github.com/settings/personal-access-tokens/new>,
elegí los repositorios y estos permisos:

| Permiso | Nivel | Para qué |
|---|---|---|
| Contents | Read | clonar / snapshot |
| Metadata | Read | obligatorio, se agrega solo |
| Issues | Read and write | listar y crear issues |
| Pull requests | Read | leer PRs |

**Opción B — classic.** <https://github.com/settings/tokens/new> con scope `repo` (y `read:user`
si querés ver tu perfil completo).

**Guardarlo.** El plugin busca la credencial en este orden:

1. `config.token` en el patch del perfil (no recomendado: queda en texto plano en `~/.dsh/profiles`),
2. variable de entorno `GITHUB_TOKEN` o `GH_TOKEN`,
3. archivo de token, en este orden: `~/.dsh/github-token`, `~/.config/dsh/github-token`, `~/.github-token`,
4. `gh auth token` si tenés la CLI de GitHub instalada y autenticada.

La forma más simple, sin tocar variables de entorno ni reiniciar el servidor:

```bash
install -m 600 /dev/null ~/.dsh/github-token
printf '%s' 'ghp_tuTokenAca' > ~/.dsh/github-token
```

Reemplazá `ghp_tuTokenAca` por tu token real (empieza con `ghp_` o `github_pat_`). Si el archivo
queda con el texto de ejemplo, GitHub responde 401 y el error indica de qué fuente salió la
credencial — así se distingue un token inválido de uno ausente.

El token se lee en cada llamada (con 30 s de caché), así que el archivo alcanza: no hace falta
reiniciar `dsh web`.

**Verificar.** Pedile a la sesión `github_account` (o usá `refresh: true` para forzar la relectura
inmediata). Debería responder con tu login, los scopes y el rate limit restante.

---

## 2. Herramientas

| Herramienta | Qué hace | Parámetros |
|---|---|---|
| `github_account` | Identidad, scopes y rate limit del token. Primer paso cuando algo falla | `refresh` |
| `github_list_repos` | Repos propios, de colaboración y de organizaciones; o los de un `owner`. Filtra por texto, visibilidad, forks y archivados | `owner`, `query`, `visibility`, `includeForks`, `includeArchived`, `sort`, `limit` |
| `github_get_repo` | Detalle de un repo: descripción, branch por defecto, lenguaje, estrellas, topics, licencia, URLs de clone | `repo` |
| `github_list_issues` | Issues y PRs de un repo, filtrables por estado, etiquetas y tipo | `repo`, `state`, `kind`, `labels`, `limit` |
| `github_create_issue` | Abre un issue (requiere permiso de escritura) | `repo`, `title`, `body`, `labels`, `assignees` |
| `github_clone_repo` | Trae el repo al workspace: `git clone --depth 1` si hay git; si no, snapshot del branch | `repo`, `ref`, `destination`, `overwrite` |

`repo` acepta `owner/name`, una URL de github.com o un remote SSH.

### Ejemplos de pedidos

- «Listame mis repos privados y mostrame los 5 más recientes.»
- «¿Qué issues abiertos con la etiqueta `bug` tiene `deepseek-ai/deepseek-harness`?»
- «Traeme `acme/demo` al workspace y resumime el README.»
- «Abrí un issue en `acme/demo` con el stack trace que te pasé.»

---

## 3. Instalación

El plugin vive en este directorio y se carga **desde el código fuente**, sin `npm install` y sin
dependencias: es un módulo ESM puro. El perfil `web` lo referencia por URL de archivo.

En `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: github-repos
      name: "file:///home/andres/Documentos/deepseek-harness/default-workspace/dsh-plugin-github/index.js"
```

Antes de editarlo se guardó un backup: `~/.dsh/profiles/web/cordis.patch.yml.bak-<fecha>`.

### Desinstalar

Borrá el bloque `- insert:` de arriba (o restaurá el backup) y reiniciá `dsh web`.

### Mover o compartir el plugin

La ruta es absoluta: si movés la carpeta, actualizá el `name` del patch. Para otro perfil, copiá el
mismo bloque en su `cordis.patch.yml`.

---

## 4. Limitaciones conocidas

- **`git` instalado** (2.55.0 en `/usr/bin/git`): `github_clone_repo` hace `git clone --depth 1`
  con historia y branch real. Si git no estuviera disponible, baja un snapshot `.tar.gz` del branch
  y lo descomprime: sirve para leer y editar, pero sin historia, commits ni ramas. El plugin detecta
  cuál de los dos modos usar y lo informa en `mode` (`git` o `snapshot`). La detección de git se hace
  una vez por proceso: si instalás git con `dsh web` corriendo, reiniciá para que lo tome.
- **Sin token** solo hay lectura pública anónima (60 req/h); los repos privados responden 404.
- **Cambios en el código** de este plugin requieren reiniciar `dsh web`: el HMR del perfil recarga la
  configuración y avisa *«changed modules keep running their previous code until a restart»*, pero no
  vuelve a importar un módulo ya cargado.
- Los errores de GitHub se traducen a instrucciones (token vencido, scope faltante, rate limit con
  hora de reset, 404 por repo privado) en lugar de mostrar el HTTP crudo.

---

## 5. Seguridad

- El token nunca se imprime en la salida de las herramientas; los mensajes de error de `git` se
  sanean antes de mostrarse.
- `git clone` recibe la credencial por variables de entorno (`GIT_CONFIG_*`), no por línea de
  comandos, así que no aparece en `ps`.
- `github_clone_repo` solo escribe dentro del directorio de trabajo de la sesión y no sobrescribe un
  directorio existente salvo `overwrite: true`.

---

## 6. Desarrollo

```bash
cd /home/andres/Documentos/deepseek-harness/default-workspace/dsh-plugin-github
npm test        # 43 tests con el runner nativo de Node
```

| Archivo | Rol |
|---|---|
| `index.js` | Registro del plugin y las 6 herramientas |
| `src/client.js` | Cliente REST: auth, JSON, listas, descargas, errores |
| `src/token.js` | Descubrimiento de credenciales |
| `src/tar.js` | Extracción `.tar.gz` sin dependencias y con protección de rutas |
| `src/git.js` | Detección de git y clone con credencial por entorno |
| `src/repo.js` | Parseo de referencias y formato para el modelo |
| `src/schema.js` | Normalización de esquemas al subconjunto JSON Schema de dsh |
| `test/` | Tests por unidad y de integración con `fetch` simulado |

Para probar el plugin en un perfil aislado sin tocar el que usás a diario, creá
`~/.dsh/profiles/prueba/package.json` con `{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}`
y el mismo bloque `- insert:` en su `cordis.patch.yml`; después:

```bash
node ~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js --profile prueba --dump-config
```

---

### Alternativa oficial

DeepSeek Harness publica `@deepseek-ai/dsh-experimental-forge-bundle`: un panel de pull requests y
worktrees para sesiones dentro de un repo git. Necesita la CLI `gh` instalada y autenticada, y
trabaja sobre un repo ya clonado; no lista ni trae repositorios, que es lo que hace este plugin.
