<h1 align="center">Synch</h1>

<p align="center">Obsidian을 위한 종단 간 암호화 동기화.</p>

<p align="center">
  <a href="https://synch.run/ko">웹사이트</a> ·
  <a href="https://synch.run/ko/self-hosting">Cloudflare 배포</a> ·
  <a href="https://synch.run/ko/self-hosting-docker">Docker 배포</a>
</p>

<p align="center">
  <a href="https://obsidian.md/plugins?id=synch"><img alt="Obsidian 커뮤니티 플러그인" src="https://img.shields.io/badge/Obsidian-Community%20Plugin-7c3aed?style=flat-square" /></a>
  <a href="../../LICENSE"><img alt="MIT 라이선스" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://synch.run/ko"><img alt="Synch 개요" src="../../.github/assets/synch-preview.webp" /></a>
</p>

---

로컬 암호화, 버전 기록, 충돌 안전 파일 처리를 통해 Obsidian 볼트를 여러 기기에서
동기화하세요.

Synch는 독립적인 커뮤니티 플러그인 및 서비스입니다. Obsidian과 제휴되어 있지
않습니다.

## Synch를 선택하는 이유

- **설계부터 개인정보 보호** — 볼트 데이터는 업로드 전에 기기에서 암호화됩니다.
- **빠른 동기화** — 변경 사항을 자주 감지해 여러 기기에서 동기화합니다.
- **복구 가능** — 암호화된 기록에서 이전 버전과 삭제된 파일을 복원할 수 있습니다.
- **충돌 안전** — 서로 겹치지 않는 Markdown 편집은 자동으로 병합할 수 있습니다.
- **호스팅 선택권** — Synch Cloud를 사용하거나 직접 Synch 서버를 운영할 수 있습니다.

## 작동 방식

```mermaid
flowchart LR
    device["내 기기"] --> encrypt["볼트 데이터를 기기에서 암호화"]
    encrypt --> server["Synch Cloud 또는 자체 호스팅 서버"]
    server --> other["다른 기기에서 다운로드 및 복호화"]
```

동기화 서비스는 암호화된 파일 blob과 암호화된 동기화 메타데이터를 저장합니다. 호스팅
서비스가 일반 텍스트 노트, 일반 텍스트 파일 경로 또는 볼트 키를 읽을 수 없도록
설계되어 있습니다.

## Obsidian 동기화 옵션 비교

각 옵션은 편의성, 제어 수준, 설정 노력 사이에서 서로 다른 균형을 제공합니다.

| 옵션 | 암호화 | 저장 모델 | 충돌 처리 | 적합한 사용자 |
| --- | --- | --- | --- | --- |
| **Synch** | 기기 측 E2EE | Synch Cloud 또는 자체 호스팅 | 겹치지 않는 Markdown 편집 자동 병합; 겹치는 충돌 보존 | 간단하고 오픈 소스이며 개인정보 보호 중심인 작업 흐름을 원하는 사용자 |
| [Obsidian Sync](https://obsidian.md/sync) | 기본 E2EE; 표준 암호화도 사용 가능 | Obsidian 호스팅 | 공식 Obsidian 통합 및 동기화 기록 | 공식 호스팅 서비스를 선호하는 사용자 |
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | E2EE | 자체 호스팅 CouchDB, 오브젝트 스토리지 또는 선택적 WebRTC | 간단한 충돌 자동 병합 | 백엔드를 최대한 직접 제어하려는 사용자 |
| [Remotely Save](https://github.com/remotely-save/remotely-save) | 선택적 비밀번호 기반 E2EE | S3, WebDAV, Dropbox, OneDrive, Google Drive 등 사용자가 선택한 저장소 | 기본 충돌 감지; 고급 스마트 충돌 처리는 Pro에서 사용 가능 | 선호하는 저장소 제공업체를 이미 사용하는 사용자 |

이 비교는 의도적으로 높은 수준에서 작성되었습니다. 중요한 볼트를 이전하기 전에 각
프로젝트의 최신 문서와 설정을 확인하세요.

## 기능

- 거의 즉시 동기화
- 암호화된 버전 기록
- 삭제된 파일 복구
- Markdown 충돌 자동 병합
- 편집이 겹칠 때 충돌 복사본 생성
- Markdown 파일 기본 활성화
- 이미지, 오디오, 비디오, PDF 파일 기본 활성화
- 추가 파일 및 폴더 제외
- 호스팅 Synch Cloud
- 자체 호스팅 배포를 위한 사용자 지정 API URL
- 데스크톱 및 모바일 Obsidian 지원

## 시작하기

### Synch Cloud

1. Obsidian에서 **설정 → Community plugins**를 엽니다.
2. 제한 모드를 끄고 **Browse**를 선택합니다.
3. **Synchrun**을 검색합니다.
4. 플러그인을 설치하고 활성화합니다.
5. Synchrun 설정을 열고 로그인합니다.
6. 원격 볼트를 만들거나 연결합니다.

연결한 뒤 Synch가 로컬 변경 사항을 업로드하고 원격 변경 사항을 다운로드하는 동안
Obsidian을 열어 두세요.

### 자체 호스팅 Synch

Cloudflare 배포 가이드는 Synch를 사용자의 Cloudflare 계정에 배포합니다. Cloudflare를
사용하지 않는 배포에는 Docker/systemd 가이드를 사용하세요.

다음 환경에서 Synch를 실행할 수 있습니다.

- Cloudflare
- Docker
- systemd를 사용하는 자체 하드웨어

배포 가이드를 참고하세요.

- [Cloudflare 배포](https://synch.run/ko/self-hosting)
- [Docker/systemd 배포](https://synch.run/ko/self-hosting-docker)

배포한 뒤 플러그인 설정에서 사용자 지정 API 기본 URL을 지정합니다.

## 안전 참고 사항

다음 작업을 하기 전에 항상 볼트를 전체 백업하세요.

- 새로운 동기화 제공업체 설치
- 다른 동기화 솔루션에서 마이그레이션
- 암호화 설정 변경
- 원격 볼트 초기화 또는 재연결

파일 감시와 충돌 해결 방식이 어떻게 상호 작용하는지 완전히 이해하지 못한다면 같은
볼트에 여러 동기화 제공업체를 사용하지 마세요.

### 고지 사항

<details>
<summary>내용 펼치기</summary>

이 섹션은 Obsidian 개발자 정책 검토와, 설치 전에 플러그인이 무엇을 하는지 이해하려는
사용자를 위해 제공됩니다.

### 계정 요구 사항

호스팅 동기화 서비스를 사용하려면 Synch 계정이 필요합니다. 계정은 기기 인증, 원격
볼트 생성 및 연결, 동기화 토큰 발급, 저장 용량 제한 적용, 서비스 접근 관리에
사용됩니다.

### 네트워크 사용

Synch는 HTTPS 및 WebSocket 연결을 통해 구성된 Synch API 기본 URL에 연결합니다.
호스팅 서비스의 경우 Synch가 운영하는 인프라에 연결됩니다. 기본 호스팅 API
엔드포인트는 `https://api.synch.run`이며, 실시간 동기화는 `wss://api.synch.run`
WebSocket 연결을 사용합니다. 플러그인은 다음 작업에 네트워크 요청을 사용합니다.

- 로그인하고 인증된 기기 세션을 유지합니다.
- 원격 볼트를 만들고, 목록을 가져오고, 연결합니다.
- 암호화된 파일 blob과 암호화된 동기화 메타데이터를 업로드합니다.
- 암호화된 파일 blob과 암호화된 동기화 메타데이터를 다운로드합니다.
- WebSocket 연결을 통해 실시간 동기화 메시지를 교환합니다.
- 계정, 결제, 할당량, 저장 용량, 동기화 상태를 읽습니다.

Synch 호스팅 인프라는 Cloudflare를 포함한 타사 제공업체를 사용합니다. Cloudflare는
호스팅, 저장소, 네트워킹, 데이터베이스, 큐 및 관련 인프라에 사용됩니다. 결제는
Polar가 처리합니다.

### Synch로 전송되는 데이터

볼트 파일 내용과 파일 경로 메타데이터는 업로드되기 전에 기기에서 암호화됩니다.
Synch는 암호화된 blob과 암호화된 동기화 메타데이터를 저장하며, 호스팅 서비스가
일반 텍스트 노트, 일반 텍스트 파일 경로, 일반 텍스트 볼트 키를 읽을 수 없도록
설계되어 있습니다.

종단 간 암호화가 모든 운영 메타데이터를 숨기지는 않습니다. Synch는 계정 정보,
볼트 식별자 및 이름, 조직 및 멤버십 기록, 로컬 볼트 식별자, blob 식별자, 파일 크기,
저장 용량 사용량, 타임스탬프, 동기화 커서, 세션 정보, IP 주소, User-Agent 문자열,
호스팅 구독의 결제 식별자 및 유사한 운영 메타데이터를 처리할 수 있습니다.

### 로컬 볼트 접근

Synch는 선택된 볼트 파일을 동기화하기 위해 현재 Obsidian 볼트 안의 파일을 읽고
씁니다. 플러그인 설정은 Obsidian의 플러그인 데이터 API로 저장하고, 기기 세션 토큰은
Obsidian의 비밀 저장소 API로 저장하며, 로컬 동기화 상태는 브라우저 IndexedDB에
저장합니다.

Synch는 현재 Obsidian 볼트 밖의 파일을 의도적으로 읽거나 쓰지 않습니다.

### 결제

호스팅 서비스는 무료 및 유료 구독 플랜을 제공합니다. 현재 유료 호스팅 플랜은
Sync Starter이며, 월간 또는 연간 결제가 가능합니다. 결제 처리와 구독 관리는
Polar가 담당합니다.

### 텔레메트리, 광고 및 개인정보 보호

Synch Obsidian 플러그인에는 클라이언트 측 텔레메트리가 포함되어 있지 않으며 광고를
표시하지 않습니다. 호스팅 서비스는 서비스를 운영, 보호, 문제 해결 및 개선하는 데
필요한 운영 로그와 서비스 메타데이터를 처리할 수 있습니다.

자세한 내용은 호스팅 서비스의 법적 문서를 읽어 보세요.

- [개인정보 처리방침](https://synch.run/privacy)
- [서비스 약관](https://synch.run/terms)

</details>

## 기여

이슈, 버그 신고, 문서 개선, 풀 리퀘스트를 환영합니다.

## 라이선스

Synch는 [MIT 라이선스](../../LICENSE)에 따라 오픈 소스로 제공됩니다.
