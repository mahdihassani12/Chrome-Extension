let intervalMs=30000,startTime=null,timer=null;
const statusEl=document.getElementById('status');
const bar=document.getElementById('bar');
const countdown=document.getElementById('countdown');
const presetBtns=[...document.querySelectorAll('.preset')];
const actionBtns={
  start:document.getElementById('start'),
  pause:document.getElementById('pause'),
  stop:document.getElementById('stop')
};

presetBtns.forEach(b=>{
  b.onclick=()=>{
    presetBtns.forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    intervalMs=+b.dataset.ms;
    countdown.textContent=`Interval set to ${intervalMs/1000}s`;
  };
});

async function tab(){
  const[t]=await chrome.tabs.query({active:true,currentWindow:true});
  return t;
}

function setState(state){
  statusEl.className='status '+state;
  statusEl.textContent=state.charAt(0).toUpperCase()+state.slice(1);

  // clear active highlight
  Object.values(actionBtns).forEach(b=>b.classList.remove('active'));

  // map state -> which action button should be active
  const activeBtnKey = (state === 'running') ? 'start' : (state === 'paused') ? 'pause' : (state === 'stopped') ? 'stop' : null;
  if (activeBtnKey && actionBtns[activeBtnKey]) actionBtns[activeBtnKey].classList.add('active');
}

actionBtns.start.onclick=async()=>{
  const t=await tab();
  startTime=Date.now();
  setState('running');
  chrome.runtime.sendMessage({
    type:'START_TAB',
    tabId:t.id,
    intervalMs,
    options:{autoStart:true,pauseWhenInactive:true,badgeCountdown:true}
  });
  clearInterval(timer);
  timer=setInterval(()=>{
    const r=Math.max(0,intervalMs-(Date.now()-startTime));
    bar.style.width=`${100-(r/intervalMs)*100}%`;
    countdown.textContent=`Next reload in ${Math.ceil(r/1000)}s`;
    if(r<=0)startTime=Date.now();
  },1000);
};

actionBtns.pause.onclick=()=>{
  setState('paused');
  clearInterval(timer);
};

actionBtns.stop.onclick=async()=>{
  const t=await tab();
  setState('stopped');
  bar.style.width='0%';
  countdown.textContent='Not running';
  clearInterval(timer);
  chrome.runtime.sendMessage({type:'STOP_TAB',tabId:t.id});
};
