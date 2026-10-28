#!/usr/bin/env bash
# Rebuild the migrated Asterisk version without source-host CPU instructions.
# Produces an isolated install tree; does not install configs or start services.
set -Eeuo pipefail
umask 077
base="${1:?Verified source/build directory}"
version="${2:-22.8.2}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
test -f "$base/source-menuselect.makeopts"
cd "$base"
sha256sum --check "asterisk-$version.sha256"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-upgrade --no-install-recommends \
  build-essential pkg-config autoconf-archive bzip2 patch \
  libedit-dev libjansson-dev libsqlite3-dev uuid-dev libxml2-dev \
  libspeex-dev libspeexdsp-dev libogg-dev libvorbis-dev libasound2-dev \
  portaudio19-dev libcurl4-openssl-dev xmlstarlet bison flex libpq-dev \
  unixodbc-dev libneon27-dev libgmime-3.0-dev liblua5.2-dev liburiparser-dev \
  libxslt1-dev libssl-dev libmysqlclient-dev libbluetooth-dev libradcli-dev \
  freetds-dev libjack-jackd2-dev libcap-dev libsnmp-dev libiksemel-dev \
  libcorosync-common-dev libcpg-dev libcfg-dev libnewt-dev libpopt-dev \
  libical-dev libspandsp-dev libresample1-dev libc-client2007e-dev binutils-dev \
  libsrtp2-dev libgsm1-dev zlib1g-dev libldap2-dev libcodec2-dev libfftw3-dev \
  libsndfile1-dev libunbound-dev libopus-dev
cd "asterisk-$version"
./configure --with-pjproject-bundled \
  CFLAGS='-O2 -march=x86-64 -mtune=generic' \
  CXXFLAGS='-O2 -march=x86-64 -mtune=generic'
make menuselect.makeopts
cp "$base/source-menuselect.makeopts" menuselect.makeopts
menuselect/menuselect --disable BUILD_NATIVE \
  --disable-category MENUSELECT_CORE_SOUNDS \
  --disable-category MENUSELECT_EXTRA_SOUNDS \
  --disable-category MENUSELECT_MOH menuselect.makeopts
! grep '^MENUSELECT_CFLAGS=.*BUILD_NATIVE' menuselect.makeopts
make -j6
make DESTDIR="$base/install" install
"$base/install/usr/sbin/asterisk" -V
printf 'Portable build staged at %s/install; live configuration unchanged\n' "$base"
