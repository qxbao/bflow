/** Trusted, digest-pinned bootstrap. Written to a private launch directory; never interpolates provider arguments or bearer env. */
export const PROCESS_SCOPE_SUPERVISOR = String.raw`import os,sys,json,time,hashlib,hmac,signal,subprocess,select,datetime

def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(value): return hashlib.sha256(canonical(value)).hexdigest()
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def read(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        if not __import__('stat').S_ISREG(st.st_mode) or st.st_size>65536 or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Unsafe process-scope record')
        return json.loads(os.read(fd,65537))
    finally: os.close(fd)
def signed(path):
    value=read(path); payload=value['payload']
    if not hmac.compare_digest(value['signature'],hmac.new(bytes.fromhex(cfg['secret']),canonical(payload),hashlib.sha256).hexdigest()): raise RuntimeError('Process-scope signature mismatch')
    return payload
def write_once(path,payload):
    value={'payload':payload,'signature':hmac.new(bytes.fromhex(cfg['secret']),canonical(payload),hashlib.sha256).hexdigest()}
    temporary=path+'.'+str(os.getpid())+'.tmp'
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try: os.write(fd,canonical(value)); os.fsync(fd)
    finally: os.close(fd)
    try:
        try: os.link(temporary,path)
        except FileExistsError: return signed(path)
    finally: os.unlink(temporary)
    directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
    return payload
def identity(pid):
    text=open('/proc/'+str(pid)+'/stat').read(); fields=text[text.rfind(')')+2:].split()
    return {'parent':int(fields[1]),'start':fields[19],'namespace':os.readlink('/proc/'+str(pid)+'/ns/pid')}
def boot(): return open('/proc/sys/kernel/random/boot_id').read().strip()
def exited(fd): return bool(select.select([fd],[],[],0)[0])
def close_receipt(witness): return write_once(root+'/closed.json',{'scopeId':cfg['scopeId'],'witnessDigest':digest(witness),'observedAt':now()})
def target_valid():
    if hashlib.sha256(open(cfg['target'],'rb').read()).hexdigest()!=cfg['targetDigest']: raise RuntimeError('Pinned provider entry changed')

mode=sys.argv[1]; config_path=sys.argv[2]; cfg=read(config_path); root=os.path.dirname(config_path)
if cfg['schemaVersion']!=1 or hashlib.sha256(open(__file__,'rb').read()).hexdigest()!=cfg['supervisorDigest']: raise RuntimeError('Process-scope bootstrap changed')
if mode=='entry':
    # bwrap --block-fd also unblocks on EOF. The provider must separately receive a signed acknowledgement for this witness.
    deadline=time.monotonic()+10
    while not os.path.exists(root+'/admit.json'):
        if os.path.exists(root+'/sealed.json') or time.monotonic()>deadline: raise RuntimeError('Provider entry lacks host acknowledgement')
        time.sleep(0.02)
    witness=signed(root+'/witness.json'); ack=signed(root+'/admit.json')
    if ack!={'scopeId':cfg['scopeId'],'witnessDigest':digest(witness)} or witness['scopeId']!=cfg['scopeId'] or witness['launchId']!=cfg['launchId'] or witness['launchFingerprint']!=cfg['launchFingerprint'] or boot()!=witness['bootId'] or identity(1)['start']!=witness['initStartTime'] or os.path.exists(root+'/sealed.json') or os.readlink('/proc/self/ns/pid')!=witness['namespace']: raise RuntimeError('Provider entry acknowledgement mismatch')
    target_valid(); os.environ['PATH']=cfg['originalPath']; signal.signal(signal.SIGINT,signal.SIG_DFL)
    os.execv(cfg['target'],[cfg['target']]+sys.argv[3:])
elif mode=='inspect':
    witness=signed(root+'/witness.json')
    if boot()!=witness['bootId'] or os.path.exists(root+'/sealed.json'): raise RuntimeError('Process scope is no longer dispatchable')
    fd=os.pidfd_open(witness['initPid'])
    try:
        if exited(fd): raise RuntimeError('Namespace already exited')
        current=identity(witness['initPid'])
        if current['start']!=witness['initStartTime'] or current['namespace']!=witness['namespace']: raise RuntimeError('Namespace identity changed')
    finally: os.close(fd)
elif mode=='stop':
    sealed=signed(root+'/sealed.json')
    if sealed['scopeId']!=cfg['scopeId']: raise RuntimeError('Missing sealed admission')
    witness=signed(root+'/witness.json')
    if witness['scopeId']!=cfg['scopeId']: raise RuntimeError('Foreign namespace witness')
    if os.path.exists(root+'/closed.json'):
        close=signed(root+'/closed.json')
        if close['witnessDigest']!=digest(witness): raise RuntimeError('Foreign namespace stop receipt')
        sys.exit(0)
    fd=None
    if boot()==witness['bootId']:
        try: fd=os.pidfd_open(witness['initPid'])
        except ProcessLookupError: pass
        if fd is not None and not exited(fd):
            try: current=identity(witness['initPid'])
            except FileNotFoundError:
                if not exited(fd): raise
                current=None
            if current is not None and current['start']==witness['initStartTime'] and current['namespace']==witness['namespace']:
                # Signal the kernel process reference, never a numeric PID after a check.
                try: signal.pidfd_send_signal(fd,signal.SIGKILL)
                except ProcessLookupError: pass
                if not select.select([fd],[],[],5)[0]: raise RuntimeError('Namespace exit remains unconfirmed')
        if fd is not None: os.close(fd)
    close_receipt(witness)
elif mode=='launch':
    if os.path.exists(root+'/sealed.json'): raise RuntimeError('Process-scope admission is sealed')
    admitted=os.open(root+'/started',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); os.fsync(admitted); os.close(admitted)
    admission_directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(admission_directory)
    finally: os.close(admission_directory)
    target_valid()
    # Keep the inherited PTY and foreground process group. Only the provider handles terminal Ctrl-C.
    signal.signal(signal.SIGINT,signal.SIG_IGN)
    info_r,info_w=os.pipe(); block_r,block_w=os.pipe(); child=None; pidfd=None
    try:
        args=[cfg['bwrap'],'--unshare-user','--unshare-pid','--die-with-parent','--cap-drop','ALL','--bind','/','/','--dev-bind','/dev','/dev','--proc','/proc','--info-fd',str(info_w),'--block-fd',str(block_r),'--',cfg['python'],__file__,'entry',config_path]+sys.argv[3:]
        child=subprocess.Popen(args,pass_fds=(info_w,block_r),stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr)
        os.close(info_w); info_w=None; os.close(block_r); block_r=None
        deadline=time.monotonic()+10; raw=b''
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0 or not select.select([info_r],[],[],remaining)[0]: raise RuntimeError('Namespace bootstrap deadline exceeded')
            chunk=os.read(info_r,4097-len(raw))
            if not chunk: break
            raw+=chunk
            if len(raw)>4096: raise RuntimeError('Oversized namespace bootstrap')
        info=json.loads(raw); init_pid=info['child-pid']; pidfd=os.pidfd_open(init_pid)
        current=identity(init_pid)
        nspid=[line for line in open('/proc/'+str(init_pid)+'/status') if line.startswith('NSpid:')][0].split()
        if child.poll() is not None or current['parent']!=child.pid or nspid[-1]!='1' or current['namespace']!='pid:['+str(info['pid-namespace'])+']': raise RuntimeError('Namespace-init identity mismatch')
        proposed_witness={'scopeId':cfg['scopeId'],'launchId':cfg['launchId'],'launchFingerprint':cfg['launchFingerprint'],'bootId':boot(),'initPid':init_pid,'initStartTime':current['start'],'namespace':current['namespace'],'startedAt':now()}
        witness=write_once(root+'/witness.json',proposed_witness)
        if witness!=proposed_witness: raise RuntimeError('Conflicting immutable launch witness')
        if os.path.exists(root+'/sealed.json'): raise RuntimeError('Process-scope admission was sealed during bootstrap')
        write_once(root+'/admit.json',{'scopeId':cfg['scopeId'],'witnessDigest':digest(witness)})
        os.write(block_w,b'1'); os.close(block_w); block_w=None
        result=child.wait()
        if not exited(pidfd):
            signal.pidfd_send_signal(pidfd,signal.SIGKILL)
            if not select.select([pidfd],[],[],5)[0]: raise RuntimeError('Namespace exit remains unconfirmed')
        close_receipt(witness)
        sys.exit(result if result>=0 else 128-result)
    finally:
        if pidfd is not None:
            if not exited(pidfd):
                try: signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                except ProcessLookupError: pass
            os.close(pidfd)
        elif child is not None and child.poll() is None: child.kill()
        if child is not None:
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: pass
        for fd in [info_r,info_w,block_r,block_w]:
            if fd is not None:
                try: os.close(fd)
                except OSError: pass
else: raise RuntimeError('Unsupported process-scope operation')
`;
