# Financial AI Agent GitHub Pages

이 폴더는 금융 AI 에이전트를 소개하는 정적 GitHub Pages 사이트입니다.

배포 대상 저장소 기준 URL:

- 저장소: `https://github.com/immaruel/Financial_AI_Agent`
- GitHub Pages 주소: `https://immaruel.github.io/Financial_AI_Agent/`

## 로컬 미리보기

정적 서버만 있으면 바로 확인할 수 있습니다.

```powershell
cd page
python -m http.server 8000
```

브라우저에서 `http://localhost:8000` 을 열면 됩니다.

## 현재 설정

`site-config.js` 는 아래 링크로 이미 연결되어 있습니다.

- `repoUrl`: `https://github.com/immaruel/Financial_AI_Agent`
- `docsUrl`: `https://github.com/immaruel/Financial_AI_Agent/tree/main/KO`
- `authorUrl`: `https://github.com/immaruel`

## GitHub Pages 배포 방식

이 프로젝트 루트에는 `.github/workflows/deploy-pages.yml` 이 포함되어 있습니다.

1. GitHub에 저장소를 생성합니다.
2. 현재 프로젝트 전체를 저장소에 push 합니다.
3. GitHub 저장소의 `Settings > Pages` 에서 `Build and deployment` 를 `GitHub Actions` 로 둡니다.
4. `main` 브랜치에 push 하면 `page` 폴더가 자동 배포됩니다.

배포가 끝나면 `https://immaruel.github.io/Financial_AI_Agent/` 에서 확인할 수 있습니다.

## 포함 파일

- `index.html`: 랜딩 페이지
- `style.css`: 페이지 스타일
- `script.js`: 인터랙션 및 그래프 동작
- `kg_data_inline.js`: 시각화용 Knowledge Graph 데이터
- `.nojekyll`: GitHub Pages에서 Jekyll 처리 비활성화
