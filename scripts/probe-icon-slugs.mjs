const urls = [
  "https://api.iconify.design/simple-icons/dingtalk.svg",
  "https://api.iconify.design/simple-icons/feishu.svg",
  "https://api.iconify.design/simple-icons/lark.svg",
  "https://api.iconify.design/simple-icons/douyin.svg",
  "https://api.iconify.design/simple-icons/jd.svg",
  "https://api.iconify.design/simple-icons/jingdong.svg",
  "https://api.iconify.design/simple-icons/yahoo.svg",
  "https://api.iconify.design/simple-icons/wecom.svg",
  "https://api.iconify.design/simple-icons/microsoft.svg",
  "https://api.iconify.design/logos/dingtalk.svg",
  "https://api.iconify.design/logos/feishu.svg",
  "https://api.iconify.design/logos/microsoft-icon.svg",
  "https://api.iconify.design/logos/linkedin-icon.svg",
  "https://api.iconify.design/mdi/microsoft-teams.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@11.14.0/icons/microsoft.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@9.21.0/icons/jd.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@9.21.0/icons/yahoo.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@9.21.0/icons/douyin.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@9.21.0/icons/dingtalk.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@9.21.0/icons/feishu.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@9.21.0/icons/lark.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@6.22.0/icons/jd.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@6.22.0/icons/yahoo.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@7.21.0/icons/jd.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@8.15.0/icons/jd.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@10.4.0/icons/jd.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@10.4.0/icons/yahoo.svg",
  "https://cdn.jsdelivr.net/npm/simple-icons@10.4.0/icons/douyin.svg",
];
for (const url of urls) {
  const res = await fetch(url);
  console.log(res.status, url.replace("https://", ""));
}
