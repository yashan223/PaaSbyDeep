import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Classify a project and build a minimal fallback Dockerfile template
 * from root directory entries and optional manifest file contents.
 */
export function classifyProject({
  files = [],
  packageJson = null,
  requirementsTxt = '',
  pyprojectToml = '',
  dockerfilePath = 'Dockerfile',
}) {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));
  const normalizedDf = String(dockerfilePath || 'Dockerfile').replace(/^\.\//, '');

  if (fileSet.has(normalizedDf.toLowerCase())) {
    return {
      projectType: 'docker',
      label: 'Dockerfile',
      hasDockerfile: true,
      suggestedPort: 3000,
      dockerfileContent: null,
    };
  }

  if (fileSet.has('package.json')) {
    const pkg = typeof packageJson === 'string' ? safeJsonParse(packageJson) : packageJson;
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    const scripts = pkg?.scripts || {};

    if (deps.next) {
      return {
        projectType: 'nextjs',
        label: 'Next.js',
        hasDockerfile: false,
        suggestedPort: 3000,
        dockerfileContent: [
          'FROM node:20-alpine',
          'WORKDIR /app',
          'COPY package*.json ./',
          'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi',
          'COPY . .',
          'RUN npm run build',
          'ENV NODE_ENV=production',
          'EXPOSE 3000',
          'CMD ["sh", "-c", "npx next start -p ${PORT:-3000} -H 0.0.0.0"]',
          '',
        ].join('\n'),
      };
    }

    const isSpaFramework = Boolean(
      deps.vite || deps['react-scripts'] || deps['@angular/cli'] || deps['@sveltejs/kit'] || deps.astro
    );
    if (isSpaFramework && scripts.build) {
      const label = deps.vite
        ? 'Vite / SPA'
        : deps['react-scripts']
          ? 'Create React App'
          : 'Frontend SPA';

      return {
        projectType: 'static-build',
        label,
        hasDockerfile: false,
        suggestedPort: 8080,
        dockerfileContent: [
          'FROM node:20-alpine AS builder',
          'WORKDIR /app',
          'COPY package*.json ./',
          'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi',
          'COPY . .',
          'RUN npm run build',
          'RUN mkdir -p /out && if [ -d dist ]; then cp -r dist/. /out/; elif [ -d build ]; then cp -r build/. /out/; elif [ -d out ]; then cp -r out/. /out/; fi',
          '',
          'FROM nginx:alpine',
          'COPY --from=builder /out /usr/share/nginx/html',
          'EXPOSE 8080',
          'CMD ["sh", "-c", "printf \'server { listen %s; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }\\n\' \\"${PORT:-8080}\\" > /etc/nginx/conf.d/default.conf && nginx -g \'daemon off;\'"]',
          '',
        ].join('\n'),
      };
    }

    const needsBuild = Boolean(scripts.build && (deps.typescript || deps['@nestjs/cli']));
    const hasStart = Boolean(scripts.start);
    const safeMain =
      typeof pkg?.main === 'string' && /^[a-zA-Z0-9._/-]+$/.test(pkg.main) ? pkg.main : 'index.js';
    const cmdLine = hasStart ? 'CMD ["npm", "start"]' : `CMD ["node", "${safeMain}"]`;

    const lines = [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      needsBuild
        ? 'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi'
        : 'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi',
      'COPY . .',
    ];
    if (needsBuild) {
      lines.push('RUN npm run build && npm prune --omit=dev');
    }
    lines.push('ENV NODE_ENV=production', 'EXPOSE 3000', cmdLine, '');

    return {
      projectType: 'nodejs',
      label: deps['@nestjs/cli'] ? 'NestJS' : deps.express ? 'Node.js (Express)' : 'Node.js',
      hasDockerfile: false,
      suggestedPort: 3000,
      dockerfileContent: lines.join('\n'),
    };
  }

  if (fileSet.has('requirements.txt') || fileSet.has('pyproject.toml')) {
    const manifest = `${requirementsTxt}\n${pyprojectToml}`.toLowerCase();
    const isFastApi = manifest.includes('fastapi') || manifest.includes('uvicorn');
    const isDjango = manifest.includes('django');
    const isFlask = manifest.includes('flask');
    const hasGunicorn = manifest.includes('gunicorn');

    const label = isFastApi
      ? 'Python (FastAPI)'
      : isDjango
        ? 'Python (Django)'
        : isFlask
          ? 'Python (Flask)'
          : 'Python';

    let entryTarget = 'main:app';
    if (!fileSet.has('main.py') && fileSet.has('app.py')) entryTarget = 'app:app';
    else if (!fileSet.has('main.py') && fileSet.has('server.py')) entryTarget = 'server:app';

    let cmd = 'CMD ["sh", "-c", "python main.py"]';
    if (isFastApi) {
      cmd = `CMD ["sh", "-c", "uvicorn ${entryTarget} --host 0.0.0.0 --port \${PORT:-8000}"]`;
    } else if (isDjango) {
      cmd = 'CMD ["sh", "-c", "python manage.py runserver 0.0.0.0:${PORT:-8000}"]';
    } else if (isFlask && hasGunicorn) {
      const wsgiTarget = fileSet.has('wsgi.py') ? 'wsgi:app' : entryTarget;
      cmd = `CMD ["sh", "-c", "gunicorn -b 0.0.0.0:\${PORT:-8000} ${wsgiTarget}"]`;
    } else if (fileSet.has('app.py')) {
      cmd = 'CMD ["sh", "-c", "python app.py"]';
    }

    const installStep = fileSet.has('requirements.txt')
      ? 'COPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .'
      : 'COPY . .\nRUN pip install --no-cache-dir .';

    return {
      projectType: 'python',
      label,
      hasDockerfile: false,
      suggestedPort: 8000,
      dockerfileContent: [
        'FROM python:3.12-slim',
        'WORKDIR /app',
        installStep,
        'EXPOSE 8000',
        cmd,
        '',
      ].join('\n'),
    };
  }

  if (fileSet.has('go.mod')) {
    return {
      projectType: 'go',
      label: 'Go',
      hasDockerfile: false,
      suggestedPort: 8080,
      dockerfileContent: [
        'FROM golang:1.22-alpine AS builder',
        'WORKDIR /app',
        'COPY go.* ./',
        'RUN go mod download',
        'COPY . .',
        'RUN CGO_ENABLED=0 go build -o /app/server .',
        '',
        'FROM alpine:3.20',
        'WORKDIR /app',
        'COPY --from=builder /app/server /app/server',
        'EXPOSE 8080',
        'CMD ["/app/server"]',
        '',
      ].join('\n'),
    };
  }

  if (fileSet.has('index.html')) {
    return {
      projectType: 'static',
      label: 'Static HTML',
      hasDockerfile: false,
      suggestedPort: 8080,
      dockerfileContent: [
        'FROM nginx:alpine',
        'COPY . /usr/share/nginx/html',
        'EXPOSE 8080',
        'CMD ["sh", "-c", "printf \'server { listen %s; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }\\n\' \\"${PORT:-8080}\\" > /etc/nginx/conf.d/default.conf && nginx -g \'daemon off;\'"]',
        '',
      ].join('\n'),
    };
  }

  return {
    projectType: 'unknown',
    label: 'Unknown',
    hasDockerfile: false,
    suggestedPort: 3000,
    dockerfileContent: null,
  };
}

/**
 * Inspect a cloned repository directory on disk and detect its project type.
 */
export function detectProjectFromDir(repoPath, dockerfilePath = 'Dockerfile') {
  const files = readdirSync(repoPath);
  const readIfExists = (name) => {
    const p = join(repoPath, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };

  const hasCustomDockerfile = existsSync(join(repoPath, dockerfilePath));
  if (hasCustomDockerfile) {
    return {
      projectType: 'docker',
      label: 'Dockerfile',
      hasDockerfile: true,
      suggestedPort: 3000,
      dockerfileContent: null,
    };
  }

  return classifyProject({
    files,
    packageJson: readIfExists('package.json') || null,
    requirementsTxt: readIfExists('requirements.txt'),
    pyprojectToml: readIfExists('pyproject.toml'),
    dockerfilePath,
  });
}
