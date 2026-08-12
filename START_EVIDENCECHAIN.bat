@echo off
setlocal EnableDelayedExpansion
REM ============================================================================
REM  EvidenceChain AI - Windows Launcher
REM  Double-click this file. It starts the backend, starts the frontend,
REM  waits until both are actually ready, then opens the app in your browser.
REM ============================================================================

title EvidenceChain AI - Launcher

REM ----------------------------------------------------------------------------
REM SECTION 1: Locate the project root from THIS .bat file's own location.
REM %~dp0 always expands to "the folder this script lives in", with a
REM trailing backslash, and works correctly even if the path contains spaces
REM (as long as we keep quoting it below). This means the launcher works no
REM matter which Windows user account or folder the project sits in.
REM ----------------------------------------------------------------------------
set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%backend"
set "FRONTEND_DIR=%ROOT_DIR%frontend"
set "VENV_PY=%BACKEND_DIR%\venv\Scripts\python.exe"
set "BACKEND_PID_FILE=%ROOT_DIR%.evidencechain_backend.pid"
set "FRONTEND_PID_FILE=%ROOT_DIR%.evidencechain_frontend.pid"
set "DEPS_MARKER=%BACKEND_DIR%\venv\.deps_installed"
set "BACKEND_RUNNER=%ROOT_DIR%.evidencechain_run_backend.cmd"
set "FRONTEND_RUNNER=%ROOT_DIR%.evidencechain_run_frontend.cmd"
set "LAUNCH_PS1=%ROOT_DIR%.evidencechain_launch.ps1"

echo ============================================================
echo   EvidenceChain AI - Starting up
echo   Project root: %ROOT_DIR%
echo ============================================================
echo.

REM ----------------------------------------------------------------------------
REM SECTION 2: Sanity-check the project structure before doing anything else.
REM ----------------------------------------------------------------------------
if not exist "%BACKEND_DIR%\main.py" (
    echo [ERROR] Could not find backend\main.py under:
    echo         %BACKEND_DIR%
    echo         This launcher must stay in the EvidenceChain AI project root,
    echo         next to the "backend" and "frontend" folders.
    goto :FAIL
)
if not exist "%FRONTEND_DIR%\package.json" (
    echo [ERROR] Could not find frontend\package.json under:
    echo         %FRONTEND_DIR%
    goto :FAIL
)

REM ----------------------------------------------------------------------------
REM SECTION 3: Check that Node.js and npm are installed and on PATH.
REM ----------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on your PATH.
    echo         Install it from https://nodejs.org ^(LTS version^) and re-run this launcher.
    goto :FAIL
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found on your PATH ^(it normally ships with Node.js^).
    echo         Reinstall Node.js from https://nodejs.org and re-run this launcher.
    goto :FAIL
)

REM ----------------------------------------------------------------------------
REM SECTION 4: Check/prepare the backend Python virtual environment.
REM If backend\venv doesn't exist yet, create it from whatever "python" is on
REM PATH, then install requirements.txt. If it already exists, we reuse it
REM as-is (never recreated on every run).
REM ----------------------------------------------------------------------------
if not exist "%VENV_PY%" (
    echo [SETUP] No virtual environment found at backend\venv - creating one now...
    where python >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Python was not found on your PATH.
        echo         Install Python 3.11+ from https://www.python.org/downloads/
        echo         ^(check "Add python.exe to PATH" during install^) and re-run this launcher.
        goto :FAIL
    )
    python -m venv "%BACKEND_DIR%\venv"
    if errorlevel 1 (
        echo [ERROR] Failed to create the Python virtual environment.
        goto :FAIL
    )
)

REM ----------------------------------------------------------------------------
REM SECTION 5: Install backend dependencies only if needed.
REM We reinstall only when requirements.txt is newer than our own marker
REM file, or the marker doesn't exist yet - not on every single launch.
REM ----------------------------------------------------------------------------
set "NEED_BACKEND_INSTALL=0"
if not exist "%DEPS_MARKER%" set "NEED_BACKEND_INSTALL=1"
if exist "%DEPS_MARKER%" (
    powershell -NoProfile -Command ^
      "if ((Get-Item '%BACKEND_DIR%\requirements.txt').LastWriteTime -gt (Get-Item '%DEPS_MARKER%').LastWriteTime) { exit 1 } else { exit 0 }"
    if errorlevel 1 set "NEED_BACKEND_INSTALL=1"
)

if "%NEED_BACKEND_INSTALL%"=="1" (
    echo [SETUP] Installing/updating backend dependencies from requirements.txt...
    echo         ^(this only happens when needed, not on every run^)
    "%VENV_PY%" -m pip install --disable-pip-version-check -q -r "%BACKEND_DIR%\requirements.txt"
    if errorlevel 1 (
        echo [ERROR] Failed to install backend dependencies. See the pip output above.
        goto :FAIL
    )
    echo done> "%DEPS_MARKER%"
) else (
    echo [OK] Backend dependencies already installed, skipping.
)

REM ----------------------------------------------------------------------------
REM SECTION 6: Install frontend dependencies only if node_modules is missing.
REM ----------------------------------------------------------------------------
if not exist "%FRONTEND_DIR%\node_modules" (
    echo [SETUP] Installing frontend dependencies ^(npm install^)...
    pushd "%FRONTEND_DIR%"
    call npm install
    set "NPM_INSTALL_ERR=%errorlevel%"
    popd
    if not "%NPM_INSTALL_ERR%"=="0" (
        echo [ERROR] npm install failed. See the output above.
        goto :FAIL
    )
) else (
    echo [OK] Frontend dependencies already installed, skipping.
)

echo.
echo ============================================================
echo   Starting services
echo ============================================================

REM ----------------------------------------------------------------------------
REM SECTION 7: Start the backend - but only if it isn't already running.
REM We check the port first so double-clicking this launcher twice never
REM spawns a duplicate backend (which would just crash with "port already
REM in use" anyway).
REM ----------------------------------------------------------------------------
set "BACKEND_ALREADY_RUNNING=0"
call :CHECK_HTTP "http://localhost:8000/health" 2
if "%HTTP_OK%"=="1" (
    echo [OK] Backend already running and healthy at http://localhost:8000 - reusing it.
    set "BACKEND_ALREADY_RUNNING=1"
) else (
    netstat -ano | findstr ":8000" | findstr "LISTENING" >nul 2>nul
    if not errorlevel 1 (
        echo [ERROR] Port 8000 is in use by another process that is not responding
        echo         to /health. Close whatever is using port 8000 and try again.
        goto :FAIL
    )

    echo [START] Launching backend ^(FastAPI / uvicorn^) in its own window...
    REM A tiny generated .cmd file avoids fragile nested-quote escaping when
    REM building a one-line "cmd /k ..." command from paths that may contain
    REM spaces - each line below is parsed normally, with no quote-doubling.
    > "%BACKEND_RUNNER%" echo @echo off
    >> "%BACKEND_RUNNER%" echo title EvidenceChain-Backend
    >> "%BACKEND_RUNNER%" echo cd /d "%BACKEND_DIR%"
    >> "%BACKEND_RUNNER%" echo "%VENV_PY%" -m uvicorn main:app --reload --port 8000

    REM Launched via a small PowerShell helper using Start-Process -PassThru,
    REM which hands back the REAL process id straight from Windows -- far
    REM more reliable than trying to re-find the window afterwards by title
    REM (title matching broke during testing: cmd.exe alters the title it's
    REM given, and Vite overwrites it again once the frontend starts).
    for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_PS1%" -ScriptPath "%BACKEND_RUNNER%" -PidFile "%BACKEND_PID_FILE%"') do set "BACKEND_PID=%%P"

    echo [WAIT] Waiting for backend health check at http://localhost:8000/health ...
    set "WAITED=0"
    :WAIT_BACKEND
    call :CHECK_HTTP "http://localhost:8000/health" 2
    if "%HTTP_OK%"=="1" goto :BACKEND_READY
    set /a WAITED+=1
    if !WAITED! GEQ 45 (
        echo [ERROR] Backend did not become healthy within 45 seconds.
        echo         Check the "EvidenceChain-Backend" window for the real error.
        goto :FAIL
    )
    "%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul
    goto :WAIT_BACKEND
    :BACKEND_READY
    echo [OK] Backend is up: http://localhost:8000
)

REM ----------------------------------------------------------------------------
REM SECTION 8: Start the frontend - same "don't start a duplicate" logic.
REM ----------------------------------------------------------------------------
call :CHECK_HTTP "http://localhost:5173" 2
if "%HTTP_OK%"=="1" (
    echo [OK] Frontend already running at http://localhost:5173 - reusing it.
) else (
    netstat -ano | findstr ":5173" | findstr "LISTENING" >nul 2>nul
    if not errorlevel 1 (
        echo [ERROR] Port 5173 is in use by another process that is not responding
        echo         as a web server. Close whatever is using port 5173 and try again.
        goto :FAIL
    )

    echo [START] Launching frontend ^(Vite dev server^) in its own window...
    > "%FRONTEND_RUNNER%" echo @echo off
    >> "%FRONTEND_RUNNER%" echo title EvidenceChain-Frontend
    >> "%FRONTEND_RUNNER%" echo cd /d "%FRONTEND_DIR%"
    >> "%FRONTEND_RUNNER%" echo call npm run dev

    for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_PS1%" -ScriptPath "%FRONTEND_RUNNER%" -PidFile "%FRONTEND_PID_FILE%"') do set "FRONTEND_PID=%%P"

    echo [WAIT] Waiting for the frontend to respond at http://localhost:5173 ...
    echo        ^(NOT a fixed timer - actually polling until it answers^)
    set "WAITED=0"
    :WAIT_FRONTEND
    call :CHECK_HTTP "http://localhost:5173" 2
    if "%HTTP_OK%"=="1" goto :FRONTEND_READY
    set /a WAITED+=1
    if !WAITED! GEQ 60 (
        echo [ERROR] Frontend did not respond within 60 seconds.
        echo         Check the "EvidenceChain-Frontend" window for the real error.
        echo         The browser will NOT be opened to a broken page.
        goto :FAIL
    )
    "%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul
    goto :WAIT_FRONTEND
    :FRONTEND_READY
    echo [OK] Frontend is up: http://localhost:5173
)

REM ----------------------------------------------------------------------------
REM SECTION 9: Everything is confirmed ready - now, and only now, open the browser.
REM ----------------------------------------------------------------------------
echo.
echo [OPEN] Opening EvidenceChain AI in your default browser...
start "" "http://localhost:5173"

echo.
echo ============================================================
echo   EvidenceChain AI is running
echo     Backend:  http://localhost:8000   (see "EvidenceChain-Backend" window)
echo     Frontend: http://localhost:5173   (see "EvidenceChain-Frontend" window)
echo.
echo   Both services keep running in their own windows.
echo   Run STOP_EVIDENCECHAIN.bat to shut them down cleanly.
echo ============================================================
echo.
pause
exit /b 0

REM ----------------------------------------------------------------------------
REM Shared failure exit: always pause so a beginner double-clicking this file
REM can actually read the error before the window disappears.
REM ----------------------------------------------------------------------------
:FAIL
echo.
echo ============================================================
echo   Startup failed - see the error above.
echo ============================================================
pause
exit /b 1

REM ----------------------------------------------------------------------------
REM Helper: CHECK_HTTP <url> <timeout_seconds>
REM Sets HTTP_OK=1 if the URL responds with any HTTP status (server is alive),
REM HTTP_OK=0 otherwise. Uses curl.exe (built into Windows 10/11 at
REM System32\curl.exe) rather than spawning PowerShell -- PowerShell's own
REM interpreter startup overhead was eating most of a short per-poll timeout
REM budget during testing, causing false "not ready" reads even once the
REM server was already responding. curl.exe has no such startup cost.
REM Note: the curl.exe path is deliberately left UNQUOTED below (it has no
REM spaces) -- cmd's "for /f ('command')" mis-parses a captured command that
REM starts with a literal quote character, which silently returns no output.
REM ----------------------------------------------------------------------------
:CHECK_HTTP
set "HTTP_OK=0"
set "HTTP_CODE="
for /f %%C in ('%SystemRoot%\System32\curl.exe -s -o nul -w "%%{http_code}" --max-time %~2 "%~1" 2^>nul') do set "HTTP_CODE=%%C"
if defined HTTP_CODE if not "%HTTP_CODE%"=="000" set "HTTP_OK=1"
exit /b 0
